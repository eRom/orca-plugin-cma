import type { BetaEnvironment } from '@anthropic-ai/sdk/resources/beta/environments/environments'
import type { BetaManagedAgentsCredential } from '@anthropic-ai/sdk/resources/beta/vaults/credentials'
import type { BetaManagedAgentsVault } from '@anthropic-ai/sdk/resources/beta/vaults/vaults'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  PACKAGE_MANAGERS,
  type CredentialForm,
  type EnvironmentForm,
  type ResourceRef,
  type SaveInput,
  type VaultForm
} from '../protocol'
import type { ClientStore } from './client'
import {
  CONFLICT_MESSAGE,
  createWriteHandlers,
  credentialCreateParams,
  credentialUpdateParams,
  environmentCreateParams,
  environmentUpdateParams,
  isStale,
  metadataPatch,
  toCredentialForm,
  toEnvironmentForm
} from './config-writes'
import { toEnvironmentDetail } from './configs'
import { validateCredentialForm } from '../shared/credential-rules'
import { metadataTextProblem, validateEnvironmentForm } from '../shared/environment-rules'

// Les fixtures sont des réponses réelles de l'API (capturées le 22/11), chargées sans `resolveJsonModule`.
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T
}

const environment = fixture<BetaEnvironment>('environment')
const vault = fixture<BetaManagedAgentsVault>('vault')
const oauthCredentials = fixture<BetaManagedAgentsCredential[]>('credentials')

// Le jeton de test : forme non hexadécimale, jamais écrit dans un fichier de preuve.
const TOKEN = 'plugin-test-token-QUOKKA'

// SYNTHÉTIQUES : le coffre de test n'a que des identifiants OAuth.
function bearerCredential(over: Partial<BetaManagedAgentsCredential> = {}): BetaManagedAgentsCredential {
  return {
    ...oauthCredentials[0],
    id: 'vcrd_bearer',
    display_name: 'Bearer',
    updated_at: 'cred-stamp',
    auth: { type: 'static_bearer', mcp_server_url: 'https://example.com/mcp' },
    ...over
  } as BetaManagedAgentsCredential
}

function variableCredential(): BetaManagedAgentsCredential {
  return {
    ...bearerCredential(),
    id: 'vcrd_var',
    display_name: 'Variable',
    auth: {
      type: 'environment_variable',
      secret_name: 'PLUGIN_TEST_VAR',
      injection_location: { header: true, body: false },
      networking: { type: 'limited', allowed_hosts: ['example.com'] }
    }
  } as unknown as BetaManagedAgentsCredential
}

function bearerForm(over: Partial<Extract<CredentialForm, { type: 'static_bearer' }>> = {}): CredentialForm {
  return { type: 'static_bearer', name: 'Bearer', mcpServerUrl: 'https://example.com/mcp', token: TOKEN, ...over }
}

function variableForm(over: Partial<Extract<CredentialForm, { type: 'environment_variable' }>> = {}): CredentialForm {
  return {
    type: 'environment_variable',
    name: 'Variable',
    secretName: 'PLUGIN_TEST_VAR',
    secretValue: 'plugin-test-secret',
    network: { mode: 'limited', allowedHosts: ['example.com'] },
    injection: { header: true, body: false },
    ...over
  }
}

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
  // Une paire de métadonnées sans clé ne peut pas partir ; une valeur vide avec une clé reste permise.
  expect(validateEnvironmentForm(limitedForm({ metadata: [{ key: '  ', value: 'x' }] }))).toBe('Metadata lines must look like key=value.')
  expect(validateEnvironmentForm(limitedForm({ metadata: [{ key: 'a', value: '' }] }))).toBe(null)
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

test('a network change sends the networking only, a package change the packages only', () => {
  const base = limitedForm()
  const withHost = limitedForm({
    network: { mode: 'limited', allowedHosts: ['example.com', 'pypi.org'], allowPackageManagers: true, allowMcpServers: true }
  })
  const networkOnly = environmentUpdateParams(withHost, base)
  expect(networkOnly).toEqual({
    config: {
      type: 'cloud',
      networking: {
        type: 'limited',
        allowed_hosts: ['example.com', 'pypi.org'],
        allow_package_managers: true,
        allow_mcp_servers: true
      }
    }
  })
  expect(Object.keys(networkOnly.config as object)).toEqual(['type', 'networking'])
  const withPackage = limitedForm({ packages: { ...noPackages, npm: ['left-pad'] } })
  const packagesOnly = environmentUpdateParams(withPackage, base)
  expect(Object.keys(packagesOnly)).toEqual(['config'])
  expect(packagesOnly.config).toEqual({ type: 'cloud', packages: { type: 'packages', ...noPackages, npm: ['left-pad'] } })
  expect(Object.keys(packagesOnly.config as object)).toEqual(['type', 'packages'])
  const unrestricted = environmentUpdateParams(limitedForm({ network: { mode: 'unrestricted' } }), base)
  expect(unrestricted.config).toEqual({ type: 'cloud', networking: { type: 'unrestricted' } })
  // Les deux changés : les deux partent.
  const both = environmentUpdateParams(
    limitedForm({ network: { mode: 'unrestricted' }, packages: { ...noPackages, npm: ['left-pad'] } }),
    base
  )
  expect(both.config).toEqual({
    type: 'cloud',
    networking: { type: 'unrestricted' },
    packages: { type: 'packages', ...noPackages, npm: ['left-pad'] }
  })
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

function fakeStore(
  options: { current?: BetaEnvironment; fail?: Error; vault?: BetaManagedAgentsVault; credential?: BetaManagedAgentsCredential } = {}
) {
  const calls: Call[] = []
  const current = options.current ?? environment
  const currentVault = options.vault ?? vault
  const currentCredential = options.credential ?? bearerCredential()
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
      vaults: {
        ...family('vaults'),
        create: record('vaults.create', { ...currentVault, id: 'vlt_new', updated_at: 'created-stamp' }),
        retrieve: record('vaults.retrieve', currentVault),
        update: record('vaults.update', { ...currentVault, updated_at: 'updated-stamp' }),
        credentials: {
          ...family('credentials'),
          create: record('credentials.create', { ...currentCredential, id: 'vcrd_new', updated_at: 'created-stamp' }),
          retrieve: record('credentials.retrieve', currentCredential),
          update: record('credentials.update', { ...currentCredential, updated_at: 'updated-stamp' })
        }
      },
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

test('metadataTextProblem refuses a line without = or with an empty key, with the exact message', () => {
  const message = 'Metadata lines must look like key=value.'
  expect(metadataTextProblem('')).toBe(null)
  expect(metadataTextProblem('a=1\n\nb=')).toBe(null)
  expect(metadataTextProblem('a=1\nfoo')).toBe(message)
  expect(metadataTextProblem('=value')).toBe(message)
  expect(metadataTextProblem('  =value')).toBe(message)
})

test('saveEnvironment sends only the packages when only the packages changed', async () => {
  const { handlers, calls } = fakeStore()
  // Le réseau est le même des deux côtés (gestionnaires de paquets permis) : seuls les paquets changent.
  const base: EnvironmentForm = {
    ...toEnvironmentForm(environment),
    network: { mode: 'limited', allowedHosts: [], allowPackageManagers: true, allowMcpServers: true }
  }
  const form = { ...base, packages: { ...base.packages, pip: [...base.packages.pip, 'plugin-test-pkg'] } }
  const result = await handlers.saveEnvironment(saveInput({ form, base }))
  expect(result.ok).toBe(true)
  const update = calls.find((call) => call.method === 'environments.update')
  const body = update?.args[1] as { config?: Record<string, unknown> }
  expect(Object.keys(body.config ?? {})).toEqual(['type', 'packages'])
})

test('toCredentialForm maps no OAuth credential and never carries a secret', () => {
  expect(oauthCredentials.length).toBe(4)
  for (const credential of oauthCredentials) {
    expect(toCredentialForm(credential)).toBe(null)
  }
  expect(toCredentialForm(bearerCredential())).toEqual({
    type: 'static_bearer',
    name: 'Bearer',
    mcpServerUrl: 'https://example.com/mcp',
    token: ''
  })
  expect(toCredentialForm(bearerCredential({ display_name: null }))).toEqual({
    type: 'static_bearer',
    name: '',
    mcpServerUrl: 'https://example.com/mcp',
    token: ''
  })
  expect(toCredentialForm(variableCredential())).toEqual({
    type: 'environment_variable',
    name: 'Variable',
    secretName: 'PLUGIN_TEST_VAR',
    secretValue: '',
    network: { mode: 'limited', allowedHosts: ['example.com'] },
    injection: { header: true, body: false }
  })
})

test('validateCredentialForm reports each rule with its exact message', () => {
  expect(validateCredentialForm(bearerForm({ token: '' }), true)).toBe('Enter the token.')
  expect(validateCredentialForm(bearerForm({ token: '   ' }), true)).toBe('Enter the token.')
  expect(validateCredentialForm(variableForm({ secretValue: '' }), true)).toBe('Enter the value.')
  expect(validateCredentialForm(bearerForm({ mcpServerUrl: ' ' }), true)).toBe('Enter the MCP server URL.')
  expect(validateCredentialForm(variableForm({ secretName: '' }), true)).toBe('Enter the variable name.')
  const seventeen = Array.from({ length: 17 }, (_, index) => `host${index}.example.com`)
  expect(validateCredentialForm(variableForm({ network: { mode: 'limited', allowedHosts: seventeen } }), true)).toBe(
    'At most 16 allowed hosts.'
  )
  expect(validateCredentialForm(variableForm({ injection: { header: false, body: false } }), true)).toBe(
    'Inject the value in a header, the body, or both.'
  )
  expect(validateCredentialForm(variableForm({ injection: { header: false, body: true } }), true)).toBe(null)
  // À la modification, un secret vide veut dire « inchangé ».
  expect(validateCredentialForm(bearerForm({ token: '' }), false)).toBe(null)
  expect(validateCredentialForm(variableForm({ secretValue: '' }), false)).toBe(null)
  expect(validateCredentialForm(bearerForm(), true)).toBe(null)
})

test('credentialCreateParams trims the bearer token, the URL and the name', () => {
  const params = credentialCreateParams(
    bearerForm({ token: `  ${TOKEN}\n`, mcpServerUrl: ' https://example.com/mcp ', name: '  Bearer ' })
  )
  expect(params).toEqual({
    display_name: 'Bearer',
    auth: { type: 'static_bearer', mcp_server_url: 'https://example.com/mcp', token: TOKEN }
  })
  expect(credentialCreateParams(bearerForm({ name: ' ' })).display_name).toBe(undefined)
})

test('credentialCreateParams sends the variable with its network and injection', () => {
  expect(credentialCreateParams(variableForm({ network: { mode: 'limited', allowedHosts: [' example.com ', ''] } }))).toEqual({
    display_name: 'Variable',
    auth: {
      type: 'environment_variable',
      secret_name: 'PLUGIN_TEST_VAR',
      secret_value: 'plugin-test-secret',
      networking: { type: 'limited', allowed_hosts: ['example.com'] },
      injection_location: { header: true, body: false }
    }
  })
  const open = credentialCreateParams(variableForm({ network: { mode: 'unrestricted' } }))
  expect((open.auth as { networking: unknown }).networking).toEqual({ type: 'unrestricted' })
})

test('credentialUpdateParams sends no auth when only the name changed and the token is empty', () => {
  const base = bearerForm({ token: '' })
  const params = credentialUpdateParams(bearerForm({ token: '', name: 'x' }), base)
  expect(params).toEqual({ display_name: 'x' })
  expect('auth' in params).toBe(false)
  expect(credentialUpdateParams(base, base)).toEqual({})
  expect(credentialUpdateParams(bearerForm({ token: '', name: '' }), base)).toEqual({ display_name: null })
})

test('credentialUpdateParams sends a typed token and never the immutable URL', () => {
  const base = bearerForm({ token: '' })
  expect(credentialUpdateParams(bearerForm({ token: ` ${TOKEN} ` }), base)).toEqual({
    auth: { type: 'static_bearer', token: TOKEN }
  })
  expect(credentialUpdateParams(bearerForm({ token: '', mcpServerUrl: 'https://other.example/mcp' }), base)).toEqual({})
})

test('credentialUpdateParams sends only the changed part of a variable', () => {
  const base = variableForm({ secretValue: '' })
  expect(credentialUpdateParams(variableForm({ secretValue: '' }), base)).toEqual({})
  expect(credentialUpdateParams(variableForm({ secretValue: 'new' }), base)).toEqual({
    auth: { type: 'environment_variable', secret_value: 'new' }
  })
  expect(
    credentialUpdateParams(variableForm({ secretValue: '', network: { mode: 'limited', allowedHosts: ['example.com', 'b.example.com'] } }), base)
  ).toEqual({
    auth: { type: 'environment_variable', networking: { type: 'limited', allowed_hosts: ['example.com', 'b.example.com'] } }
  })
  expect(credentialUpdateParams(variableForm({ secretValue: '', injection: { header: true, body: true } }), base)).toEqual({
    auth: { type: 'environment_variable', injection_location: { header: true, body: true } }
  })
  expect(credentialUpdateParams(variableForm({ secretValue: '', secretName: 'OTHER' }), base)).toEqual({})
})

function vaultInput(over: Partial<SaveInput<VaultForm>> = {}): SaveInput<VaultForm> {
  return { id: vault.id, baseUpdatedAt: vault.updated_at, force: false, form: { name: 'renamed' }, base: { name: vault.display_name }, ...over }
}

test('saveVault creates a vault and returns its id and stamp', async () => {
  const { handlers, calls } = fakeStore()
  const result = await handlers.saveVault(vaultInput({ id: null, baseUpdatedAt: null, base: null, form: { name: ' plugin-test-vault-t5 ' } }))
  expect(result).toEqual({ ok: true, value: { id: 'vlt_new', updatedAt: 'created-stamp' } })
  expect(calls).toEqual([{ method: 'vaults.create', args: [{ display_name: 'plugin-test-vault-t5' }] }])
})

test('saveVault renames with the matching stamp, refuses a stale one, and forces on request', async () => {
  const fresh = fakeStore()
  expect(await fresh.handlers.saveVault(vaultInput())).toEqual({ ok: true, value: { id: vault.id, updatedAt: 'updated-stamp' } })
  expect(fresh.calls.find((call) => call.method === 'vaults.update')?.args).toEqual([vault.id, { display_name: 'renamed' }])

  const moved = fakeStore({ vault: { ...vault, updated_at: 'moved' } })
  expect(await moved.handlers.saveVault(vaultInput())).toEqual({ ok: false, code: 'conflict', error: CONFLICT_MESSAGE })
  expect(moved.calls.map((call) => call.method)).toEqual(['vaults.retrieve'])

  const forced = fakeStore({ vault: { ...vault, updated_at: 'moved' } })
  expect((await forced.handlers.saveVault(vaultInput({ force: true }))).ok).toBe(true)
  expect(forced.calls.some((call) => call.method === 'vaults.update')).toBe(true)
})

test('saveVault rejects a blank name and an update without a loaded form, with no network call', async () => {
  const { handlers, calls } = fakeStore()
  expect(await handlers.saveVault(vaultInput({ form: { name: ' ' } }))).toEqual({ ok: false, code: 'invalid', error: 'A name is required.' })
  const noBase = await handlers.saveVault(vaultInput({ base: null }))
  expect(!noBase.ok && noBase.code).toBe('invalid')
  expect(calls).toEqual([])
})

test('saveVault writes nothing when the name did not change', async () => {
  const { handlers, calls } = fakeStore()
  const result = await handlers.saveVault(vaultInput({ form: { name: vault.display_name } }))
  expect(result).toEqual({ ok: true, value: { id: vault.id, updatedAt: vault.updated_at } })
  expect(calls.map((call) => call.method)).toEqual(['vaults.retrieve'])
})

function credentialInput(over: Partial<SaveInput<CredentialForm> & { vaultId: string }> = {}): SaveInput<CredentialForm> & { vaultId: string } {
  const base = bearerForm({ token: '' })
  return {
    vaultId: vault.id,
    id: 'vcrd_bearer',
    baseUpdatedAt: 'cred-stamp',
    force: false,
    form: bearerForm({ token: TOKEN }),
    base,
    ...over
  }
}

test('saveCredential creates a bearer in its vault and the result carries no secret', async () => {
  const { handlers, calls, logs } = fakeStore()
  const result = await handlers.saveCredential(credentialInput({ id: null, baseUpdatedAt: null, base: null }))
  expect(result).toEqual({ ok: true, value: { id: 'vcrd_new', updatedAt: 'created-stamp' } })
  expect(calls[0]?.method).toBe('credentials.create')
  expect(calls[0]?.args[0]).toBe(vault.id)
  expect((calls[0]?.args[1] as { auth: { token: string } }).auth.token).toBe(TOKEN)
  expect(JSON.stringify(result).includes(TOKEN)).toBe(false)
  expect(logs.join('\n').includes(TOKEN)).toBe(false)
})

test('saveCredential replaces the token on a matching stamp and sends the vault id', async () => {
  const { handlers, calls } = fakeStore()
  const result = await handlers.saveCredential(credentialInput())
  expect(result).toEqual({ ok: true, value: { id: 'vcrd_bearer', updatedAt: 'updated-stamp' } })
  expect(calls[0]).toEqual({ method: 'credentials.retrieve', args: ['vcrd_bearer', { vault_id: vault.id }] })
  expect(calls[1]).toEqual({
    method: 'credentials.update',
    args: ['vcrd_bearer', { vault_id: vault.id, auth: { type: 'static_bearer', token: TOKEN } }]
  })
})

test('saveCredential refuses a stale stamp unless forced, and writes nothing when nothing changed', async () => {
  const moved = fakeStore({ credential: bearerCredential({ updated_at: 'moved' }) })
  expect(await moved.handlers.saveCredential(credentialInput())).toEqual({ ok: false, code: 'conflict', error: CONFLICT_MESSAGE })
  expect(moved.calls.map((call) => call.method)).toEqual(['credentials.retrieve'])

  const forced = fakeStore({ credential: bearerCredential({ updated_at: 'moved' }) })
  expect((await forced.handlers.saveCredential(credentialInput({ force: true }))).ok).toBe(true)

  const same = fakeStore()
  const unchanged = await same.handlers.saveCredential(credentialInput({ form: bearerForm({ token: '' }) }))
  expect(unchanged).toEqual({ ok: true, value: { id: 'vcrd_bearer', updatedAt: 'cred-stamp' } })
  expect(same.calls.map((call) => call.method)).toEqual(['credentials.retrieve'])
})

test('saveCredential rejects an invalid form, a missing base and a type change, with no network call', async () => {
  const { handlers, calls } = fakeStore()
  expect(await handlers.saveCredential(credentialInput({ id: null, baseUpdatedAt: null, base: null, form: bearerForm({ token: '' }) }))).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Enter the token.'
  })
  expect((await handlers.saveCredential(credentialInput({ base: null }))).ok).toBe(false)
  const typeChange = await handlers.saveCredential(credentialInput({ form: variableForm() }))
  expect(!typeChange.ok && typeChange.code).toBe('invalid')
  expect(calls).toEqual([])
})

test('saveCredential never leaks the secret through an API failure or the log', async () => {
  for (const secretValue of [TOKEN, 'plugin-test-secret']) {
    const form = secretValue === TOKEN ? bearerForm() : variableForm()
    const { handlers, logs } = fakeStore({ fail: new Error(`Rejected value ${secretValue} for the credential`) })
    const result = await handlers.saveCredential(credentialInput({ id: null, baseUpdatedAt: null, base: null, form }))
    expect(result).toEqual({ ok: false, code: 'other', error: 'Rejected value [secret] for the credential' })
    expect(logs).toEqual(['credential.save failed: Rejected value [secret] for the credential'])
  }
  // Même échec à la modification (le garde `retrieve` lève avant l'écriture).
  const update = fakeStore({ fail: new Error(`bad ${TOKEN}`) })
  const failed = await update.handlers.saveCredential(credentialInput())
  expect(JSON.stringify(failed).includes(TOKEN)).toBe(false)
  expect(update.logs.join('\n').includes(TOKEN)).toBe(false)
})
