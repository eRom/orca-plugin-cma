import type { BetaEnvironment } from '@anthropic-ai/sdk/resources/beta/environments/environments'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PACKAGE_MANAGERS, type EnvironmentForm, type ResourceRef, type SaveInput } from '../protocol'
import type { ClientStore } from './client'
import {
  CONFLICT_MESSAGE,
  createWriteHandlers,
  environmentCreateParams,
  environmentUpdateParams,
  isStale,
  metadataPatch,
  toEnvironmentForm
} from './config-writes'
import { toEnvironmentDetail } from './configs'
import { validateEnvironmentForm } from '../shared/environment-rules'

// Les fixtures sont des réponses réelles de l'API (capturées le 22/11), chargées sans `resolveJsonModule`.
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T
}

const environment = fixture<BetaEnvironment>('environment')

const noPackages = { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] }

function limitedForm(over: Partial<EnvironmentForm> = {}): EnvironmentForm {
  return {
    name: 'plugin-test-env',
    description: '',
    hosting: 'cloud',
    network: { mode: 'limited', allowedHosts: ['example.com'], allowPackageManagers: true, allowMcpServers: true },
    packages: { ...noPackages },
    metadata: [],
    ...over
  }
}

test('maps the real environment fixture to a form', () => {
  const form = toEnvironmentForm(environment)
  expect(form.name).toBe('incident-commander-env')
  expect(form.description).toBe('')
  expect(form.hosting).toBe('cloud')
  expect(form.network).toEqual({ mode: 'limited', allowedHosts: [], allowPackageManagers: false, allowMcpServers: true })
  expect(Object.keys(form.packages)).toEqual([...PACKAGE_MANAGERS])
  for (const manager of PACKAGE_MANAGERS) {
    expect(form.packages[manager]).toEqual([])
  }
  expect(form.metadata).toEqual([])
})

test('the environment detail carries the description, the update stamp and the form', () => {
  const detail = toEnvironmentDetail({ ...environment, description: 'Sandbox for triage' })
  expect(detail.description).toBe('Sandbox for triage')
  expect(detail.updatedAt).toBe('2026-11-22T05:55:29.031689Z')
  expect(detail.form.description).toBe('Sandbox for triage')
  expect(toEnvironmentDetail(environment).description).toBe(null)
  expect(toEnvironmentDetail(environment).form).toEqual(toEnvironmentForm(environment))
})

test('keeps a self-hosted environment without a network or packages', () => {
  const selfHosted = { ...environment, config: { type: 'self_hosted' } } as BetaEnvironment
  const form = toEnvironmentForm(selfHosted)
  expect(form.hosting).toBe('self_hosted')
  for (const manager of PACKAGE_MANAGERS) {
    expect(form.packages[manager]).toEqual([])
  }
})

test('metadataPatch deletes removed keys and sends only new or changed ones', () => {
  expect(
    metadataPatch(
      [
        { key: 'a', value: '1' },
        { key: 'c', value: '3' }
      ],
      [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' }
      ]
    )
  ).toEqual({ b: null, c: '3' })
  expect(metadataPatch([{ key: 'a', value: '2' }], [{ key: 'a', value: '1' }])).toEqual({ a: '2' })
  expect(metadataPatch([{ key: 'a', value: '1' }], [{ key: 'a', value: '1' }])).toEqual({})
})

test('validateEnvironmentForm reports each rule with its message', () => {
  expect(validateEnvironmentForm(limitedForm({ name: '   ' }))).toBe('A name is required.')
  const hosts = Array.from({ length: 17 }, (_, index) => `host${index}.example.com`)
  expect(
    validateEnvironmentForm(
      limitedForm({ network: { mode: 'limited', allowedHosts: hosts, allowPackageManagers: true, allowMcpServers: true } })
    )
  ).toBe('At most 16 allowed hosts.')
  expect(
    validateEnvironmentForm(
      limitedForm({
        network: { mode: 'limited', allowedHosts: [], allowPackageManagers: false, allowMcpServers: true },
        packages: { ...noPackages, pip: ['requests'] }
      })
    )
  ).toBe("Package installs need 'Allow package managers' in a limited network.")
  expect(validateEnvironmentForm(limitedForm())).toBe(null)
  // 16 hôtes pile : accepté. Un réseau sans limite n'impose rien aux paquets.
  const sixteen = hosts.slice(0, 16)
  expect(
    validateEnvironmentForm(
      limitedForm({ network: { mode: 'limited', allowedHosts: sixteen, allowPackageManagers: true, allowMcpServers: true } })
    )
  ).toBe(null)
  expect(validateEnvironmentForm(limitedForm({ network: { mode: 'unrestricted' }, packages: { ...noPackages, pip: ['requests'] } }))).toBe(null)
})

test('a self-hosted form ignores network and package rules', () => {
  const form = limitedForm({
    hosting: 'self_hosted',
    network: { mode: 'limited', allowedHosts: [], allowPackageManagers: false, allowMcpServers: false },
    packages: { ...noPackages, pip: ['requests'] }
  })
  expect(validateEnvironmentForm(form)).toBe(null)
  expect(environmentCreateParams(form).config).toEqual({ type: 'self_hosted' })
})

test('environmentCreateParams sends the cloud config, trimmed name and metadata', () => {
  const params = environmentCreateParams(
    limitedForm({
      name: '  plugin-test-env  ',
      description: 'A test',
      packages: { ...noPackages, pip: [' requests ', ''] },
      metadata: [{ key: 'purpose', value: 'plugin-test' }]
    })
  )
  expect(params).toEqual({
    name: 'plugin-test-env',
    description: 'A test',
    config: {
      type: 'cloud',
      networking: { type: 'limited', allowed_hosts: ['example.com'], allow_package_managers: true, allow_mcp_servers: true },
      packages: { type: 'packages', apt: [], cargo: [], gem: [], go: [], npm: [], pip: ['requests'] }
    },
    metadata: { purpose: 'plugin-test' }
  })
  // Sans description, le champ ne part pas.
  expect(environmentCreateParams(limitedForm()).description).toBe(undefined)
})

test('environmentUpdateParams sends only the top-level fields that differ', () => {
  const base = limitedForm()
  expect(environmentUpdateParams({ ...base, description: 'new' }, base)).toEqual({ description: 'new' })
  expect(environmentUpdateParams({ ...base, name: 'renamed' }, base)).toEqual({ name: 'renamed' })
  expect(environmentUpdateParams(base, base)).toEqual({})
  expect(environmentUpdateParams({ ...base, metadata: [{ key: 'a', value: '1' }] }, base)).toEqual({ metadata: { a: '1' } })
  // Vider une description chargée se dit par `null`.
  expect(environmentUpdateParams(base, { ...base, description: 'old' })).toEqual({ description: null })
})

test('a network or package change sends the whole config', () => {
  const base = limitedForm()
  const withHost = limitedForm({
    network: { mode: 'limited', allowedHosts: ['example.com', 'pypi.org'], allowPackageManagers: true, allowMcpServers: true }
  })
  expect(environmentUpdateParams(withHost, base)).toEqual({
    config: {
      type: 'cloud',
      networking: {
        type: 'limited',
        allowed_hosts: ['example.com', 'pypi.org'],
        allow_package_managers: true,
        allow_mcp_servers: true
      },
      packages: { type: 'packages', ...noPackages }
    }
  })
  const withPackage = limitedForm({ packages: { ...noPackages, npm: ['left-pad'] } })
  const sent = environmentUpdateParams(withPackage, base)
  expect(Object.keys(sent)).toEqual(['config'])
  expect(sent.config).toEqual({
    type: 'cloud',
    networking: { type: 'limited', allowed_hosts: ['example.com'], allow_package_managers: true, allow_mcp_servers: true },
    packages: { type: 'packages', ...noPackages, npm: ['left-pad'] }
  })
  const unrestricted = environmentUpdateParams(limitedForm({ network: { mode: 'unrestricted' } }), base)
  expect((unrestricted.config as { networking: unknown }).networking).toEqual({ type: 'unrestricted' })
})

test('isStale compares the update stamp unless the save is forced', () => {
  expect(isStale('t2', { baseUpdatedAt: 't1', force: false })).toBe(true)
  expect(isStale('t1', { baseUpdatedAt: 't1', force: false })).toBe(false)
  expect(isStale('t2', { baseUpdatedAt: 't1', force: true })).toBe(false)
  // Sans point de départ connu, on ne peut pas prouver que rien n'a bougé.
  expect(isStale('t1', { baseUpdatedAt: null, force: false })).toBe(true)
})

// Faux client : note chaque appel (méthode et arguments) et sert l'environnement donné.
type Call = { method: string; args: unknown[] }

function fakeStore(options: { current?: BetaEnvironment; fail?: Error } = {}) {
  const calls: Call[] = []
  const current = options.current ?? environment
  const record =
    (method: string, result: unknown = {}) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      if (options.fail) throw options.fail
      return result
    }
  const family = (name: string) => ({
    archive: record(`${name}.archive`),
    delete: record(`${name}.delete`)
  })
  const client = {
    beta: {
      agents: { archive: record('agents.archive') },
      environments: {
        ...family('environments'),
        create: record('environments.create', { ...current, id: 'env_new', updated_at: 'created-stamp' }),
        retrieve: record('environments.retrieve', current),
        update: record('environments.update', { ...current, updated_at: 'updated-stamp' })
      },
      vaults: { ...family('vaults'), credentials: family('credentials') },
      memoryStores: { ...family('memoryStores'), memories: { delete: record('memories.delete') } },
      sessions: family('sessions')
    }
  }
  const store = {
    get: async () => client,
    reset() {},
    hasKey: async () => true
  } as unknown as ClientStore
  const logs: string[] = []
  return { handlers: createWriteHandlers(store, (message) => logs.push(message)), calls, logs }
}

function saveInput(over: Partial<SaveInput<EnvironmentForm>> = {}): SaveInput<EnvironmentForm> {
  const base = toEnvironmentForm(environment)
  return {
    id: environment.id,
    baseUpdatedAt: environment.updated_at,
    force: false,
    form: { ...base, description: 'new' },
    base,
    ...over
  }
}

test('saveEnvironment creates an environment and returns its id and stamp', async () => {
  const { handlers, calls } = fakeStore()
  const result = await handlers.saveEnvironment(saveInput({ id: null, baseUpdatedAt: null, base: null, form: limitedForm() }))
  expect(result).toEqual({ ok: true, value: { id: 'env_new', updatedAt: 'created-stamp' } })
  expect(calls.map((call) => call.method)).toEqual(['environments.create'])
  expect((calls[0]?.args[0] as { name: string }).name).toBe('plugin-test-env')
})

test('saveEnvironment refuses a stale save with a conflict and never updates', async () => {
  const { handlers, calls } = fakeStore({ current: { ...environment, updated_at: '2026-11-22T09:00:00Z' } })
  const result = await handlers.saveEnvironment(saveInput())
  expect(result).toEqual({ ok: false, code: 'conflict', error: CONFLICT_MESSAGE })
  expect(CONFLICT_MESSAGE).toBe('Changed elsewhere since you opened it.')
  expect(calls.map((call) => call.method)).toEqual(['environments.retrieve'])
})

test('saveEnvironment updates only the changed fields when the stamp matches', async () => {
  const { handlers, calls } = fakeStore()
  const result = await handlers.saveEnvironment(saveInput())
  expect(result).toEqual({ ok: true, value: { id: environment.id, updatedAt: 'updated-stamp' } })
  const update = calls.find((call) => call.method === 'environments.update')
  expect(update?.args).toEqual([environment.id, { description: 'new' }])
})

test('saveEnvironment with force updates even when the stamp moved', async () => {
  const { handlers, calls } = fakeStore({ current: { ...environment, updated_at: '2026-11-22T09:00:00Z' } })
  const result = await handlers.saveEnvironment(saveInput({ force: true }))
  expect(result.ok).toBe(true)
  expect(calls.some((call) => call.method === 'environments.update')).toBe(true)
})

test('saveEnvironment rejects an invalid form without any network call', async () => {
  const { handlers, calls } = fakeStore()
  const result = await handlers.saveEnvironment(saveInput({ form: { ...toEnvironmentForm(environment), name: ' ' } }))
  expect(result).toEqual({ ok: false, code: 'invalid', error: 'A name is required.' })
  expect(calls).toEqual([])
})

test('saveEnvironment rejects an update that carries no loaded form', async () => {
  const { handlers, calls } = fakeStore()
  const result = await handlers.saveEnvironment(saveInput({ base: null }))
  expect(result.ok).toBe(false)
  expect(!result.ok && result.code).toBe('invalid')
  expect(calls).toEqual([])
})

test('saveEnvironment turns an API failure into a readable result and logs it', async () => {
  const { handlers, logs } = fakeStore({ fail: new Error('boom') })
  const result = await handlers.saveEnvironment(saveInput({ id: null, baseUpdatedAt: null, base: null, form: limitedForm() }))
  expect(result).toEqual({ ok: false, code: 'other', error: 'boom' })
  expect(logs).toEqual(['environment.save failed: boom'])
})

test('archive calls the matching SDK method with the right identifiers', async () => {
  const cases: [ResourceRef, string, unknown[]][] = [
    [{ kind: 'agent', id: 'agent_1' }, 'agents.archive', ['agent_1']],
    [{ kind: 'environment', id: 'env_1' }, 'environments.archive', ['env_1']],
    [{ kind: 'vault', id: 'vlt_1' }, 'vaults.archive', ['vlt_1']],
    [{ kind: 'memory_store', id: 'memstore_1' }, 'memoryStores.archive', ['memstore_1']],
    [{ kind: 'session', id: 'sesn_1' }, 'sessions.archive', ['sesn_1']],
    [{ kind: 'credential', vaultId: 'vlt_1', id: 'vcrd_1' }, 'credentials.archive', ['vcrd_1', { vault_id: 'vlt_1' }]]
  ]
  for (const [ref, method, args] of cases) {
    const { handlers, calls } = fakeStore()
    expect(await handlers.archive(ref)).toEqual({ ok: true, value: null })
    expect(calls).toEqual([{ method, args }])
  }
})

test('remove calls the matching SDK method with the right identifiers', async () => {
  const cases: [ResourceRef, string, unknown[]][] = [
    [{ kind: 'environment', id: 'env_1' }, 'environments.delete', ['env_1']],
    [{ kind: 'vault', id: 'vlt_1' }, 'vaults.delete', ['vlt_1']],
    [{ kind: 'memory_store', id: 'memstore_1' }, 'memoryStores.delete', ['memstore_1']],
    [{ kind: 'session', id: 'sesn_1' }, 'sessions.delete', ['sesn_1']],
    [{ kind: 'credential', vaultId: 'vlt_1', id: 'vcrd_1' }, 'credentials.delete', ['vcrd_1', { vault_id: 'vlt_1' }]],
    [{ kind: 'memory', memoryStoreId: 'memstore_1', id: 'mem_1' }, 'memories.delete', ['mem_1', { memory_store_id: 'memstore_1' }]]
  ]
  for (const [ref, method, args] of cases) {
    const { handlers, calls } = fakeStore()
    expect(await handlers.remove(ref)).toEqual({ ok: true, value: null })
    expect(calls).toEqual([{ method, args }])
  }
})

test('agents can only be archived and memories only deleted, without a network call', async () => {
  const { handlers, calls } = fakeStore()
  expect(await handlers.remove({ kind: 'agent', id: 'agent_1' })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Agents can only be archived.'
  })
  expect(await handlers.archive({ kind: 'memory', memoryStoreId: 'memstore_1', id: 'mem_1' })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Memories can only be deleted.'
  })
  expect(calls).toEqual([])
})

test('an API 409 on archive or remove comes back as other, never as a conflict', async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const refusal = Anthropic.APIError.generate(
    409,
    { type: 'error', error: { type: 'invalid_request_error', message: 'Still in use.' } },
    'Still in use.',
    new Headers()
  )
  const { handlers } = fakeStore({ fail: refusal })
  const archived = await handlers.archive({ kind: 'environment', id: 'env_1' })
  const removed = await handlers.remove({ kind: 'environment', id: 'env_1' })
  for (const result of [archived, removed]) {
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe('other')
    expect(!result.ok && result.error.includes('Still in use.')).toBe(true)
  }
})
