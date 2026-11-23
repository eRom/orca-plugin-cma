import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'
import { CONFLICT_MESSAGE, attempt, createClientStore, createProbeClient, describeError, probeKey, workspaceInfo, type ClientStore } from './client'
import type { WorkspaceIndex, Workspaces } from './workspaces'

test('describeError maps API errors', () => {
  const error = new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
  expect(describeError(error)).toEqual({ message: 'The API key was rejected (401).', code: 'unauthorized' })
})

// Corps réel capturé le 22/11 (docs/superpowers/runs/lot2/t7-precondition-probe.log).
const preconditionBody = {
  type: 'error',
  error: { type: 'memory_precondition_failed_error', message: 'precondition content_sha256 failed: content has changed' },
  request_id: 'req_test'
}

test('describeError maps a memory precondition refusal to conflict', () => {
  const error = new Anthropic.ConflictError(409, preconditionBody, undefined, new Headers())
  expect(describeError(error)).toEqual({ message: CONFLICT_MESSAGE, code: 'conflict' })
})

test('describeError keeps the API message for any other 409', () => {
  const body = { type: 'error', error: { type: 'memory_path_conflict_error', message: 'a memory already exists at /probe.md' } }
  const error = new Anthropic.ConflictError(409, body, undefined, new Headers())
  expect(describeError(error)).toEqual({ message: 'API error 409: a memory already exists at /probe.md', code: 'other' })
})

test('describeError keeps the API message for a 412', () => {
  const body = { type: 'error', error: { type: 'precondition_failed', message: 'etag mismatch' } }
  const error = Anthropic.APIError.generate(412, body, undefined, new Headers())
  expect(describeError(error)).toEqual({ message: 'API error 412: etag mismatch', code: 'other' })
})

test('describeError maps unknown errors to other', () => {
  expect(describeError(new Error('x'))).toEqual({ message: 'x', code: 'other' })
})

// Faux magasin dont le client répond selon les scénarios : seule la liste des agents existe. Tout autre appel
// (l'organisation par exemple) lève : `workspaceInfo` n'en fait plus aucun.
function fakeStore(key: string | null, scenario: { agents: Error | null }): ClientStore {
  const client = {
    beta: {
      agents: {
        list: () => ({
          withResponse: async () => {
            if (scenario.agents) {
              throw scenario.agents
            }
            return { response: { headers: new Headers({ 'anthropic-workspace-id': 'wrkspc_test' }) } }
          }
        })
      }
    }
  }
  return {
    get: async () => client as unknown as Anthropic,
    reset: () => {},
    hasKey: async () => key !== null
  }
}

const unauthorized = () => new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())

// Faux `Workspaces` : seulement ce que `workspaceInfo` lit et note.
function fakeWorkspaces(entries: WorkspaceIndex['entries'], activeLocalId: string | null) {
  const noted: string[][] = []
  const workspaces = {
    index: async (): Promise<WorkspaceIndex> => ({ entries, activeLocalId, migratedLocalId: null }),
    noteWorkspaceId: async (localId: string, workspaceId: string) => {
      noted.push([localId, workspaceId])
      entries = entries.map((entry) => (entry.localId === localId ? { ...entry, workspaceId } : entry))
    }
  } as unknown as Workspaces
  return { workspaces, noted }
}

const DEFAULT_ENTRY = { localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_test' }
const DEFAULT_ROW = { ...DEFAULT_ENTRY, active: true }

test('createClientStore reads the active key and says no_key when there is none', async () => {
  const store = createClientStore(async () => null)
  expect(await store.hasKey()).toBe(false)
  expect(await attempt(store, async () => 1)).toEqual({ ok: false, code: 'no_key', error: 'Add your Anthropic API key first.' })
})

test('createClientStore caches the client until reset and rereads the active key after', async () => {
  let reads = 0
  let key = 'plugin-test-token-QUOKKA-a'
  const store = createClientStore(async () => {
    reads += 1
    return key
  })
  const first = await store.get()
  expect(await store.get()).toBe(first)
  expect(reads).toBe(1)
  key = 'plugin-test-token-QUOKKA-b'
  store.reset()
  expect((await store.get()) === first).toBe(false)
  expect(reads).toBe(2)
})

test('createClientStore drops a client built on a key read before a reset', async () => {
  let key = 'plugin-test-token-QUOKKA-old'
  const pending: ((value: string) => void)[] = []
  const store = createClientStore(
    () =>
      new Promise<string>((resolve) => {
        // Chaque lecture de clé reste en attente jusqu'à ce que le test la résolve.
        pending.push(resolve)
      })
  )
  const stale = store.get()
  // Le workspace actif change pendant la lecture de la clé : reset puis nouvelle clé.
  store.reset()
  key = 'plugin-test-token-QUOKKA-new'
  pending[0]!('plugin-test-token-QUOKKA-old')
  // La lecture périmée relance une lecture avec la clé fraîche.
  await new Promise((resolve) => setTimeout(resolve, 0))
  pending[1]!(key)
  expect((await stale).apiKey).toBe('plugin-test-token-QUOKKA-new')
  // Le client mis en cache est bien celui de la nouvelle clé.
  expect((await store.get()).apiKey).toBe('plugin-test-token-QUOKKA-new')
  expect(pending.length).toBe(2)
})

test('workspaceInfo without key lists the workspaces and does no network call', async () => {
  const { workspaces } = fakeWorkspaces([], null)
  const store = createClientStore(async () => null)
  expect(await workspaceInfo(store, workspaces)).toEqual({
    hasKey: false,
    keyRejected: false,
    workspaceId: null,
    organizationName: null,
    workspaces: []
  })
})

test('workspaceInfo reports hasKey false when the key of the active entry is missing, and keeps the rows', async () => {
  const { workspaces } = fakeWorkspaces([DEFAULT_ENTRY], 'ws_1')
  const store = createClientStore(async () => null)
  expect(await workspaceInfo(store, workspaces)).toEqual({
    hasKey: false,
    keyRejected: false,
    workspaceId: null,
    organizationName: null,
    workspaces: [DEFAULT_ROW]
  })
})

test('workspaceInfo marks only the active row', async () => {
  const other = { localId: 'ws_2', name: 'Other', workspaceId: 'wrkspc_other' }
  const { workspaces } = fakeWorkspaces([DEFAULT_ENTRY, other], 'ws_1')
  const store = fakeStore('plugin-test-token-QUOKKA-a', { agents: null })
  const info = await workspaceInfo(store, workspaces)
  expect(info.workspaces).toEqual([DEFAULT_ROW, { ...other, active: false }])
  expect(info).toEqual({
    hasKey: true,
    keyRejected: false,
    workspaceId: 'wrkspc_test',
    organizationName: null,
    workspaces: [DEFAULT_ROW, { ...other, active: false }]
  })
})

test('workspaceInfo notes the workspace id read when the active entry did not know it', async () => {
  const { workspaces, noted } = fakeWorkspaces([{ ...DEFAULT_ENTRY, workspaceId: null }], 'ws_1')
  const store = fakeStore('plugin-test-token-QUOKKA-a', { agents: null })
  const info = await workspaceInfo(store, workspaces)
  expect(noted).toEqual([['ws_1', 'wrkspc_test']])
  expect(info.workspaces).toEqual([DEFAULT_ROW])
})

test('workspaceInfo notes nothing when the id is already known', async () => {
  const { workspaces, noted } = fakeWorkspaces([DEFAULT_ENTRY], 'ws_1')
  const store = fakeStore('plugin-test-token-QUOKKA-a', { agents: null })
  await workspaceInfo(store, workspaces)
  expect(noted).toEqual([])
})

test('workspaceInfo notes nothing and reports a rejected key on a 401', async () => {
  const { workspaces, noted } = fakeWorkspaces([{ ...DEFAULT_ENTRY, workspaceId: null }], 'ws_1')
  const store = fakeStore('plugin-test-token-QUOKKA-a', { agents: unauthorized() })
  expect(await workspaceInfo(store, workspaces)).toEqual({
    hasKey: true,
    keyRejected: true,
    workspaceId: null,
    organizationName: null,
    workspaces: [{ ...DEFAULT_ROW, workspaceId: null }]
  })
  expect(noted).toEqual([])
})

test('workspaceInfo makes no organization call: one agents list is the only request', async () => {
  const { workspaces } = fakeWorkspaces([DEFAULT_ENTRY], 'ws_1')
  const store = fakeStore('plugin-test-token-QUOKKA-a', { agents: null })
  expect(await workspaceInfo(store, workspaces)).toEqual({
    hasKey: true,
    keyRejected: false,
    workspaceId: 'wrkspc_test',
    organizationName: null,
    workspaces: [DEFAULT_ROW]
  })
})

test('workspaceInfo throws any error other than a 401', async () => {
  const { workspaces } = fakeWorkspaces([DEFAULT_ENTRY], 'ws_1')
  const store = fakeStore('plugin-test-token-QUOKKA-a', { agents: new Anthropic.APIConnectionError({ message: 'offline' }) })
  let thrown: unknown = null
  await workspaceInfo(store, workspaces).catch((error: unknown) => {
    thrown = error
  })
  expect(describeError(thrown).message).toBe('Could not reach api.anthropic.com.')
})

// Faux client de sondage : seul `beta.agents.list(...).withResponse()` est lu.
function probeClient(outcome: Error | string | null) {
  return {
    beta: {
      agents: {
        list: () => ({
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome
            }
            const headers = outcome === null ? new Headers() : new Headers({ 'anthropic-workspace-id': outcome })
            return { response: { headers } }
          }
        })
      }
    }
  } as unknown as Anthropic
}

test('probeKey reads the workspace id of the key', async () => {
  const keys: string[] = []
  const probe = (outcome: Error | string | null) =>
    probeKey('plugin-test-token-QUOKKA-a', (key) => (keys.push(key), probeClient(outcome)))
  expect(await probe('wrkspc_a')).toEqual({ workspaceId: 'wrkspc_a' })
  expect(await probe(null)).toEqual({ workspaceId: null })
  expect(keys).toEqual(['plugin-test-token-QUOKKA-a', 'plugin-test-token-QUOKKA-a'])
})

test('the probe client gives up after 10 s and never retries', () => {
  const client = createProbeClient('plugin-test-token-QUOKKA-a')
  expect(client.timeout).toBe(10_000)
  expect(client.maxRetries).toBe(0)
})

test('probeKey says rejected on a 401 and throws any other error', async () => {
  expect(await probeKey('k', () => probeClient(unauthorized()))).toBe('rejected')
  let thrown: unknown = null
  await probeKey('k', () => probeClient(new Anthropic.APIConnectionError({ message: 'offline' }))).catch((error: unknown) => {
    thrown = error
  })
  expect(describeError(thrown).code).toBe('other')
})

test('describeError shows only the API message of a standard error body', () => {
  const error = new Anthropic.BadRequestError(
    400,
    {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'auth.mcp_server_url must use HTTPS' },
      request_id: 'req_plugin_test'
    },
    undefined,
    new Headers()
  )
  expect(describeError(error)).toEqual({ message: 'API error 400: auth.mcp_server_url must use HTTPS', code: 'other' })
})

test('describeError falls back to the SDK message when the body carries no API message', () => {
  const noBody = new Anthropic.InternalServerError(500, undefined, 'upstream down', new Headers())
  expect(describeError(noBody)).toEqual({ message: `API error 500: ${noBody.message}`, code: 'other' })
  const emptyMessage = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'x', message: '' } }, undefined, new Headers())
  expect(describeError(emptyMessage).message).toBe(`API error 400: ${emptyMessage.message}`)
})
