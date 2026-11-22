import type { BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import type { BetaEnvironment } from '@anthropic-ai/sdk/resources/beta/environments/environments'
import type {
  BetaManagedAgentsMemory,
  BetaManagedAgentsMemoryListItem
} from '@anthropic-ai/sdk/resources/beta/memory-stores/memories'
import type { BetaManagedAgentsMemoryStore } from '@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores'
import type { BetaManagedAgentsCredential } from '@anthropic-ai/sdk/resources/beta/vaults/credentials'
import type { BetaManagedAgentsVault } from '@anthropic-ai/sdk/resources/beta/vaults/vaults'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DETAIL_TEXT_LIMIT_BYTES } from '../protocol'
import type { ClientStore } from './client'
import {
  createConfigHandlers,
  toAgentDetail,
  toConfigRow,
  toEnvironmentDetail,
  toMemoryContent,
  toMemoryRows,
  toMemoryStoreDetail,
  toVaultDetail
} from './configs'

// Les fixtures sont des réponses réelles de l'API (capturées le 22/11), chargées sans `resolveJsonModule`.
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T
}

const agent = fixture<BetaManagedAgentsAgent>('agent')
const environment = fixture<BetaEnvironment>('environment')
const memoryStore = fixture<BetaManagedAgentsMemoryStore>('memory-store')
const memories = fixture<BetaManagedAgentsMemory[]>('memories')
const vault = fixture<BetaManagedAgentsVault>('vault')
const credentials = fixture<BetaManagedAgentsCredential[]>('credentials')

test('maps the Incident commander agent', () => {
  const detail = toAgentDetail(agent)
  expect(detail.kind).toBe('agent')
  expect(detail.id).toBe('agent_01DV6uCPTjRmUYstZEFsjQfS')
  expect(detail.name).toBe('Incident commander')
  expect(detail.version).toBe(5)
  expect(detail.model).toBe('claude-haiku-5-5')
  expect(detail.effort).toBe('high')
  expect(detail.description).toBe('Triages incident ticket')
  expect(detail.system.truncated).toBe(false)
  expect(detail.system.text.startsWith('You are an on-call incident commander')).toBe(true)
  expect(detail.builtinTools?.enabled).toBe(true)
  expect(detail.builtinTools?.policy).toBe('auto')
  expect(detail.builtinTools?.overrides).toEqual([
    { name: 'web_search', enabled: false, policy: 'auto' },
    { name: 'web_fetch', enabled: false, policy: 'auto' }
  ])
  expect(detail.mcpServers.length).toBe(1)
  expect(detail.mcpServers[0]?.name).toBe('github')
  expect(detail.mcpServers[0]?.url).toBe('https://api.githubcopilot.com/mcp/')
  expect(detail.mcpServers[0]?.enabled).toBe(true)
  expect(detail.mcpServers[0]?.policy).toBe('always_ask')
  expect(detail.mcpServers[0]?.overrides).toEqual([])
  expect(detail.skills).toEqual([])
  expect(detail.multiagent).toBe(null)
})

test('clips a long system prompt', () => {
  const detail = toAgentDetail({ ...agent, system: 'x'.repeat(100_000) })
  expect(detail.system.truncated).toBe(true)
  expect(new TextEncoder().encode(detail.system.text).length <= DETAIL_TEXT_LIMIT_BYTES).toBe(true)
})

test('keeps a missing system prompt, effort and toolsets as empty values', () => {
  const detail = toAgentDetail({
    ...agent,
    system: null,
    model: { id: 'claude-haiku-5-5' },
    tools: [],
    mcp_servers: [{ type: 'url', name: 'orphan', url: 'https://example.test/mcp' }]
  })
  expect(detail.system).toEqual({ text: '', truncated: false })
  expect(detail.effort).toBe(null)
  expect(detail.builtinTools).toBe(null)
  // Un serveur déclaré sans `mcp_toolset` n'expose aucun outil : on ne l'affiche pas comme actif.
  expect(detail.mcpServers[0]?.name).toBe('orphan')
  expect(detail.mcpServers[0]?.enabled).toBe(false)
  expect(detail.mcpServers[0]?.policy).toBe(null)
  expect(detail.mcpServers[0]?.overrides).toEqual([])
})

test('joins each MCP server with its toolset and per-tool settings', () => {
  const detail = toAgentDetail({
    ...agent,
    mcp_servers: [
      { type: 'url', name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
      { type: 'url', name: 'linear', url: 'https://mcp.linear.app/mcp' }
    ],
    tools: [
      {
        type: 'mcp_toolset',
        mcp_server_name: 'linear',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [{ name: 'delete_issue', enabled: false, permission_policy: { type: 'always_ask' } }]
      },
      {
        type: 'mcp_toolset',
        mcp_server_name: 'github',
        default_config: { enabled: false, permission_policy: { type: 'always_ask' } },
        configs: []
      }
    ]
  })
  expect(detail.mcpServers[0]?.name).toBe('github')
  expect(detail.mcpServers[0]?.enabled).toBe(false)
  expect(detail.mcpServers[0]?.policy).toBe('always_ask')
  expect(detail.mcpServers[1]?.name).toBe('linear')
  expect(detail.mcpServers[1]?.policy).toBe('always_allow')
  expect(detail.mcpServers[1]?.overrides).toEqual([{ name: 'delete_issue', enabled: false, policy: 'always_ask' }])
})

test('lists skill ids', () => {
  const detail = toAgentDetail({
    ...agent,
    skills: [
      { type: 'anthropic', skill_id: 'xlsx', version: 'latest' },
      { type: 'custom', skill_id: 'skill_01abc', version: '3' }
    ]
  })
  expect(detail.skills).toEqual(['xlsx', 'skill_01abc'])
})

// SYNTHÉTIQUES, jamais observés : aucun agent multiagent n'existe dans le workspace de test.
test('summarizes both multiagent shapes on one line', () => {
  const coordinator = toAgentDetail({
    ...agent,
    multiagent: {
      type: 'coordinator',
      agents: [
        { type: 'agent', id: 'agent_a', version: 2 },
        { type: 'agent', id: 'agent_b', version: 1 },
        { type: 'advisor', model: 'claude-opus-5-5' }
      ]
    }
  })
  expect(coordinator.multiagent).toBe('Coordinator: 2 agents, advisor claude-opus-5-5')

  const unified = toAgentDetail({
    ...agent,
    multiagent: {
      type: 'multiagent_20261001',
      advisor: { type: 'enabled', model: 'claude-opus-5-5' },
      subagents: {
        type: 'enabled',
        inline_agents: { type: 'disabled' },
        predefined_agents: [{ type: 'agent', id: 'agent_a', version: 2 }]
      },
      workflows: { type: 'disabled' }
    }
  })
  expect(unified.multiagent).toBe('Multiagent: advisor claude-opus-5-5, subagents (1 predefined)')

  const none = toAgentDetail({
    ...agent,
    multiagent: {
      type: 'multiagent_20261001',
      advisor: { type: 'disabled' },
      subagents: { type: 'disabled' },
      workflows: { type: 'disabled' }
    }
  })
  expect(none.multiagent).toBe('Multiagent: all disabled')
})

test('maps the environment network', () => {
  const detail = toEnvironmentDetail(environment)
  expect(detail.kind).toBe('environment')
  expect(detail.id).toBe('env_01DH6Y3bU8txBGZfrmsqyxhY')
  expect(detail.name).toBe('incident-commander-env')
  expect(detail.hosting).toBe('cloud')
  expect(detail.network).toEqual({
    mode: 'limited',
    allowedHosts: [],
    allowPackageManagers: false,
    allowMcpServers: true
  })
  expect(detail.packages).toEqual([])
  expect(detail.metadata).toEqual([])
})

test('maps an unrestricted environment with packages and metadata', () => {
  const detail = toEnvironmentDetail({
    ...environment,
    metadata: { team: 'sre' },
    config: {
      type: 'cloud',
      networking: { type: 'unrestricted' },
      packages: { type: 'packages', pip: ['pandas', 'numpy'], npm: [], apt: ['jq'], cargo: [], gem: [], go: [] }
    }
  })
  expect(detail.network).toEqual({ mode: 'unrestricted' })
  expect(detail.packages).toEqual([
    { key: 'apt', value: 'jq' },
    { key: 'pip', value: 'pandas, numpy' }
  ])
  expect(detail.metadata).toEqual([{ key: 'team', value: 'sre' }])
})

// SYNTHÉTIQUE : aucun environnement `self_hosted` n'existe dans le workspace de test.
test('marks a self-hosted network as host managed', () => {
  const selfHosted = { ...environment, config: { type: 'self_hosted' } } as BetaEnvironment
  const detail = toEnvironmentDetail(selfHosted)
  expect(detail.hosting).toBe('self_hosted')
  expect(detail.network).toEqual({ mode: 'host_managed' })
  expect(detail.packages).toEqual([])
  expect(toConfigRow('environment', selfHosted).summary).toBe('self_hosted · host managed')
})

test('flattens memories', () => {
  expect(toMemoryRows(memories)).toEqual([
    { id: 'mem_019QkfaDRwFebDCcpZEwq2S9', path: '/SOULD.md', sizeBytes: 67, updatedAt: '2026-11-22T07:33:08.244906Z' }
  ])
  const detail = toMemoryStoreDetail(memoryStore, toMemoryRows(memories))
  expect(detail.kind).toBe('memory_store')
  expect(detail.id).toBe('memstore_014xvEA4PybjSgmsJNaUQVxu')
  expect(detail.name).toBe('orca-memory-001')
  expect(detail.description).toBe('Ceci est un test')
  expect(detail.memories.length).toBe(1)
})

// Un `memory_prefix` n'est qu'un marqueur sans id : il ne devient jamais une ligne de mémoire.
test('drops prefix markers and keeps full nested paths', () => {
  const nested = { ...memories[0], id: 'mem_nested', path: '/notes/2026/todo.md' } as BetaManagedAgentsMemory
  const items: BetaManagedAgentsMemoryListItem[] = [
    nested,
    { type: 'memory_prefix', path: '/notes/' },
    memories[0] as BetaManagedAgentsMemory
  ]
  expect(toMemoryRows(items).map((row) => row.path)).toEqual(['/notes/2026/todo.md', '/SOULD.md'])
})

test('gives an empty description to a memory store without one', () => {
  expect(toMemoryStoreDetail({ ...memoryStore, description: '' }, []).description).toBe(null)
})

test('maps a memory with its content clipped', () => {
  const full = { ...memories[0], content: 'y'.repeat(100_000) } as BetaManagedAgentsMemory
  const content = toMemoryContent(full)
  expect(content.id).toBe('mem_019QkfaDRwFebDCcpZEwq2S9')
  expect(content.memoryStoreId).toBe('memstore_014xvEA4PybjSgmsJNaUQVxu')
  expect(content.path).toBe('/SOULD.md')
  expect(content.content.truncated).toBe(true)
  expect(toMemoryContent({ ...full, content: null }).content).toEqual({ text: '', truncated: false })
})

test('maps the vault credentials without a secret', () => {
  const detail = toVaultDetail(vault, credentials)
  expect(detail.kind).toBe('vault')
  expect(detail.name).toBe('Incident commander vault')
  expect(detail.credentials.length).toBe(4)
  expect(detail.credentials[0]).toEqual({
    id: 'vcrd_019HDHQc6abaUqPp4BvsThfK',
    name: 'GitHub',
    type: 'mcp_oauth',
    mcpServerUrl: 'https://api.githubcopilot.com/mcp',
    expiresAt: '2026-11-22T13:56:49Z'
  })
})

test('never exposes credential secrets', () => {
  const allowed = new Set<string>()
  const forbidden = new Set<string>()
  // Les valeurs réelles de `auth` hors `type`, `mcp_server_url` et `expires_at` (refresh : client, scope, endpoint...).
  const collect = (value: unknown, into: Set<string>) => {
    if (typeof value === 'string') {
      into.add(value)
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) collect(child, into)
    }
  }
  for (const credential of credentials) {
    const { type, mcp_server_url: url, expires_at: expiry, ...rest } = credential.auth as unknown as Record<string, unknown>
    collect([type, url, expiry], allowed)
    collect(rest, forbidden)
  }
  // `resource` vaut l'URL du serveur pour GitHub : une valeur autorisée ne compte pas comme une fuite.
  const leaked = [...forbidden].filter((value) => !allowed.has(value))
  expect(leaked.length > 0).toBe(true)

  // Un secret inventé dans chaque forme de `auth` : aucun champ n'est recopié, seule une liste blanche passe.
  const planted = credentials.map((credential) => ({
    ...credential,
    auth: {
      ...credential.auth,
      access_token: 'PLANTED-ACCESS-TOKEN',
      token: 'PLANTED-BEARER',
      secret_value: 'PLANTED-SECRET-VALUE'
    }
  })) as BetaManagedAgentsCredential[]
  const serialized = JSON.stringify(toVaultDetail(vault, planted))
  for (const value of leaked) {
    expect(serialized.includes(JSON.stringify(value))).toBe(false)
  }
  for (const secret of ['PLANTED-ACCESS-TOKEN', 'PLANTED-BEARER', 'PLANTED-SECRET-VALUE']) {
    expect(serialized.includes(secret)).toBe(false)
  }
})

// SYNTHÉTIQUES : le coffre de test n'a que des identifiants OAuth.
test('maps bearer and environment variable credentials and skips archived ones', () => {
  const base = { ...credentials[0], metadata: {}, display_name: null } as BetaManagedAgentsCredential
  const detail = toVaultDetail(vault, [
    { ...base, id: 'vcrd_bearer', auth: { type: 'static_bearer', mcp_server_url: 'https://example.test/mcp' } },
    {
      ...base,
      id: 'vcrd_env',
      auth: {
        type: 'environment_variable',
        secret_name: 'SENTRY_DSN',
        injection_location: { type: 'environment_variable' },
        networking: { type: 'unrestricted' }
      }
    } as unknown as BetaManagedAgentsCredential,
    { ...base, id: 'vcrd_old', archived_at: '2026-11-22T10:00:00Z' }
  ])
  expect(detail.credentials).toEqual([
    { id: 'vcrd_bearer', name: 'https://example.test/mcp', type: 'static_bearer', mcpServerUrl: 'https://example.test/mcp', expiresAt: null },
    { id: 'vcrd_env', name: 'SENTRY_DSN', type: 'environment_variable', mcpServerUrl: null, expiresAt: null }
  ])
})

test('summarizes each kind of row', () => {
  expect(toConfigRow('agent', agent)).toEqual({
    kind: 'agent',
    id: 'agent_01DV6uCPTjRmUYstZEFsjQfS',
    name: 'Incident commander',
    summary: 'claude-haiku-5-5 · v5'
  })
  expect(toConfigRow('environment', environment).summary).toBe('cloud · limited')
  expect(toConfigRow('memory_store', memoryStore)).toEqual({
    kind: 'memory_store',
    id: 'memstore_014xvEA4PybjSgmsJNaUQVxu',
    name: 'orca-memory-001',
    summary: 'Ceci est un test'
  })
  expect(toConfigRow('memory_store', { ...memoryStore, description: '' }).summary).toBe('')
  expect(toConfigRow('vault', vault, { credentialCount: 1 })).toEqual({
    kind: 'vault',
    id: 'vlt_011ChHT4XGPzfAoAGvxqa8v1',
    name: 'Incident commander vault',
    summary: '1 credential'
  })
  expect(toConfigRow('vault', vault, { credentialCount: 4 }).summary).toBe('4 credentials')
  expect(toConfigRow('vault', vault, { credentialCount: 0 }).summary).toBe('0 credentials')
})

// Faux client : sert les objets donnés, y compris archivés (le worker doit les écarter lui-même),
// et note les paramètres de `memories.retrieve`.
function fakeStore(options: { fail?: boolean } = {}) {
  const retrieved: { memoryId: string; params: unknown }[] = []
  const list = <T>(items: T[]) => () => ({
    async *[Symbol.asyncIterator]() {
      yield* items
    }
  })
  const archivedAgent = { ...agent, id: 'agent_old', name: 'Old', archived_at: '2026-11-22T10:00:00Z' }
  const archivedVault = { ...vault, id: 'vlt_old', display_name: 'Old vault', archived_at: '2026-11-22T10:00:00Z' }
  const client = {
    beta: {
      agents: { list: list([agent, archivedAgent]), retrieve: async () => agent },
      environments: {
        list: list([environment, { ...environment, id: 'env_old', archived_at: '2026-11-22T10:00:00Z' }]),
        retrieve: async () => environment
      },
      memoryStores: {
        list: list([memoryStore, { ...memoryStore, id: 'memstore_old', archived_at: '2026-11-22T10:00:00Z' }]),
        retrieve: async () => memoryStore,
        memories: {
          list: list<BetaManagedAgentsMemoryListItem>([...memories, { type: 'memory_prefix', path: '/x/' }]),
          retrieve: async (memoryId: string, params: unknown) => {
            retrieved.push({ memoryId, params })
            return { ...memories[0], content: 'hello' }
          }
        }
      },
      vaults: {
        list: list([vault, archivedVault]),
        retrieve: async () => vault,
        credentials: { list: list([...credentials, { ...credentials[0], id: 'vcrd_old', archived_at: '2026-11-22T10:00:00Z' }]) }
      }
    }
  }
  const store = {
    get: async () => {
      if (options.fail) throw new Error('boom')
      return client
    },
    reset() {},
    hasKey: async () => true
  } as unknown as ClientStore
  return { store, retrieved }
}

test('configs.list excludes archived objects for each kind and counts vault credentials', async () => {
  const handlers = createConfigHandlers(fakeStore().store)
  const agents = await handlers.list({ kind: 'agent' })
  expect(agents).toEqual({
    ok: true,
    value: [{ kind: 'agent', id: 'agent_01DV6uCPTjRmUYstZEFsjQfS', name: 'Incident commander', summary: 'claude-haiku-5-5 · v5' }]
  })
  const environments = await handlers.list({ kind: 'environment' })
  expect(environments.ok && environments.value.map((row) => row.id)).toEqual(['env_01DH6Y3bU8txBGZfrmsqyxhY'])
  const stores = await handlers.list({ kind: 'memory_store' })
  expect(stores.ok && stores.value.map((row) => row.id)).toEqual(['memstore_014xvEA4PybjSgmsJNaUQVxu'])
  const vaults = await handlers.list({ kind: 'vault' })
  expect(vaults).toEqual({
    ok: true,
    value: [{ kind: 'vault', id: 'vlt_011ChHT4XGPzfAoAGvxqa8v1', name: 'Incident commander vault', summary: '4 credentials' }]
  })
})

test('configs.detail reads each kind and builds a flat memory list for a store', async () => {
  const handlers = createConfigHandlers(fakeStore().store)
  const agentDetail = await handlers.detail({ kind: 'agent', id: 'agent_01DV6uCPTjRmUYstZEFsjQfS' })
  expect(agentDetail.ok && agentDetail.value.kind).toBe('agent')
  const envDetail = await handlers.detail({ kind: 'environment', id: 'env_01DH6Y3bU8txBGZfrmsqyxhY' })
  expect(envDetail.ok && envDetail.value.kind).toBe('environment')
  const storeDetail = await handlers.detail({ kind: 'memory_store', id: 'memstore_014xvEA4PybjSgmsJNaUQVxu' })
  expect(storeDetail.ok && storeDetail.value.kind === 'memory_store' && storeDetail.value.memories.map((row) => row.path)).toEqual([
    '/SOULD.md'
  ])
  const vaultDetail = await handlers.detail({ kind: 'vault', id: 'vlt_011ChHT4XGPzfAoAGvxqa8v1' })
  expect(vaultDetail.ok && vaultDetail.value.kind === 'vault' && vaultDetail.value.credentials.length).toBe(4)
})

test('memory.read retrieves the full view of one memory', async () => {
  const { store, retrieved } = fakeStore()
  const result = await createConfigHandlers(store).readMemory({
    memoryStoreId: 'memstore_014xvEA4PybjSgmsJNaUQVxu',
    memoryId: 'mem_019QkfaDRwFebDCcpZEwq2S9'
  })
  expect(retrieved).toEqual([
    { memoryId: 'mem_019QkfaDRwFebDCcpZEwq2S9', params: { memory_store_id: 'memstore_014xvEA4PybjSgmsJNaUQVxu', view: 'full' } }
  ])
  expect(result.ok && result.value.content).toEqual({ text: 'hello', truncated: false })
})

test('createForm.options gathers the active agents, environments, vaults and memory stores', async () => {
  const result = await createConfigHandlers(fakeStore().store).formOptions()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.agents.map((row) => row.id)).toEqual(['agent_01DV6uCPTjRmUYstZEFsjQfS'])
  expect(result.value.environments.map((row) => row.id)).toEqual(['env_01DH6Y3bU8txBGZfrmsqyxhY'])
  expect(result.value.vaults.map((row) => row.summary)).toEqual(['4 credentials'])
  expect(result.value.memoryStores.map((row) => row.id)).toEqual(['memstore_014xvEA4PybjSgmsJNaUQVxu'])
})

test('handlers turn an API failure into a readable result', async () => {
  const handlers = createConfigHandlers(fakeStore({ fail: true }).store)
  const listed = await handlers.list({ kind: 'agent' })
  expect(listed.ok).toBe(false)
  const options = await handlers.formOptions()
  expect(options.ok).toBe(false)
  const read = await handlers.readMemory({ memoryStoreId: 'm', memoryId: 'x' })
  expect(read.ok).toBe(false)
})
