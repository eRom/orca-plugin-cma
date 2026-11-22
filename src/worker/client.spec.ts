import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'
import { createClientStore, describeError, setKey, workspaceInfo, type ClientStore } from './client'

test('describeError maps API errors', () => {
  const error = new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
  expect(describeError(error)).toEqual({ message: 'The API key was rejected (401).', code: 'unauthorized' })
})

test('describeError maps unknown errors to other', () => {
  expect(describeError(new Error('x'))).toEqual({ message: 'x', code: 'other' })
})

test('workspaceInfo without key', async () => {
  // `mockHost` n'expose pas d'API de secrets : un faux littéral suffit, et le fait qu'il
  // ne contienne aucune clé doit éviter tout appel réseau.
  const store = createClientStore({ get: async () => null, set: async () => {}, delete: async () => {} })
  expect(await workspaceInfo(store)).toEqual({
    hasKey: false,
    keyRejected: false,
    workspaceId: null,
    organizationName: null
  })
})

// Faux secrets en mémoire qui notent leurs appels ; l'objet `api` a la forme de `orca.secrets`.
function fakeSecrets(initial: string | null = null) {
  const state = { value: initial, calls: [] as string[] }
  const api = {
    get: async () => state.value,
    set: async (_name: string, value: string) => {
      state.calls.push('set')
      state.value = value
    },
    delete: async () => {
      state.calls.push('delete')
      state.value = null
    }
  }
  return { state, api }
}

// Faux magasin dont le client répond selon les scénarios : liste des agents et organisation.
function fakeStore(
  secrets: ReturnType<typeof fakeSecrets>,
  scenario: { agents: Error | null; organization: Error | { name: string } }
): ClientStore {
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
      },
      organization: {
        retrieve: async () => {
          if (scenario.organization instanceof Error) {
            throw scenario.organization
          }
          return scenario.organization
        }
      }
    }
  }
  return {
    get: async () => client as unknown as Anthropic,
    reset: () => {},
    hasKey: async () => Boolean(secrets.state.value)
  }
}

const unauthorized = () => new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())

test('setKey deletes the key on 401', async () => {
  const secrets = fakeSecrets()
  const store = fakeStore(secrets, { agents: unauthorized(), organization: { name: 'Org' } })
  const result = await setKey(secrets.api, store, ' sk-bad ')
  expect(result).toEqual({ ok: false, error: 'The API key was rejected (401).', code: 'unauthorized' })
  expect(secrets.state.value).toBe(null)
  expect(secrets.state.calls).toEqual(['set', 'delete'])
})

test('setKey deletes the key on a network error', async () => {
  const secrets = fakeSecrets()
  const store = fakeStore(secrets, {
    agents: new Anthropic.APIConnectionError({ message: 'offline' }),
    organization: { name: 'Org' }
  })
  const result = await setKey(secrets.api, store, 'sk-any')
  expect(result).toEqual({ ok: false, error: 'Could not reach api.anthropic.com.', code: 'other' })
  expect(secrets.state.value).toBe(null)
})

test('setKey keeps a valid key', async () => {
  const secrets = fakeSecrets()
  const store = fakeStore(secrets, { agents: null, organization: { name: 'Org' } })
  const result = await setKey(secrets.api, store, ' sk-good ')
  expect(result).toEqual({
    ok: true,
    value: { hasKey: true, keyRejected: false, workspaceId: 'wrkspc_test', organizationName: 'Org' }
  })
  expect(secrets.state.value).toBe('sk-good')
  expect(secrets.state.calls).toEqual(['set'])
})

test('workspaceInfo survives a failing organization call', async () => {
  const secrets = fakeSecrets('sk-good')
  const store = fakeStore(secrets, {
    agents: null,
    organization: new Anthropic.PermissionDeniedError(403, undefined, 'forbidden', new Headers())
  })
  expect(await workspaceInfo(store)).toEqual({
    hasKey: true,
    keyRejected: false,
    workspaceId: 'wrkspc_test',
    organizationName: null
  })
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
