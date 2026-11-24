// Configurations en lecture seule : agents, environnements, banques de mémoire et coffres.
// Les conversions sont pures et choisissent leurs champs un à un (jamais de recopie d'un objet de
// l'API) ; les handlers n'ont que les appels réseau en plus.
import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaManagedAgentsAgent,
  BetaManagedAgentsAgentToolset20260401,
  BetaManagedAgentsMCPToolset
} from '@anthropic-ai/sdk/resources/beta/agents/agents'
import type { BetaEnvironment } from '@anthropic-ai/sdk/resources/beta/environments/environments'
import type {
  BetaManagedAgentsMemory,
  BetaManagedAgentsMemoryListItem
} from '@anthropic-ai/sdk/resources/beta/memory-stores/memories'
import type { BetaManagedAgentsMemoryStore } from '@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores'
import type { BetaManagedAgentsCredential } from '@anthropic-ai/sdk/resources/beta/vaults/credentials'
import type { BetaManagedAgentsVault } from '@anthropic-ai/sdk/resources/beta/vaults/vaults'
import {
  DETAIL_TEXT_LIMIT_BYTES,
  PACKAGE_MANAGERS,
  type AgentDetail,
  type ApiResult,
  type ConfigDetail,
  type ConfigKind,
  type ConfigRow,
  type CreateFormOptions,
  type CredentialRow,
  type EnvironmentDetail,
  type KeyValueItem,
  type MemoryContent,
  type MemoryRow,
  type MemoryStoreDetail,
  type ToolPolicy,
  type ToolsetView,
  type VaultDetail
} from '../protocol'
import { clipBytes } from '../shared/text'
import { toAgentForm } from './agent-form'
import { attempt, type ClientStore } from './client'
import { toCredentialForm, toEnvironmentForm } from './config-writes'

type ConfigObjects = {
  agent: BetaManagedAgentsAgent
  environment: BetaEnvironment
  memory_store: BetaManagedAgentsMemoryStore
  vault: BetaManagedAgentsVault
}

type PolicyHolder = { permission_policy: { type: ToolPolicy } }

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function toolsetView(
  defaults: { enabled: boolean } & PolicyHolder,
  configs: ({ name: string; enabled: boolean } & PolicyHolder)[]
): ToolsetView {
  return {
    enabled: defaults.enabled,
    policy: defaults.permission_policy.type,
    overrides: configs.map((config) => ({
      name: config.name,
      enabled: config.enabled,
      policy: config.permission_policy.type
    }))
  }
}

/** Le réseau d'un environnement `cloud` ; `self_hosted` n'en porte pas, l'hôte le gère. */
function networkMode(env: BetaEnvironment): string {
  return env.config.type === 'cloud' ? env.config.networking.type : 'host managed'
}

/**
 * La ligne de liste d'un objet. `extra.credentialCount` ne sert qu'aux coffres : l'API ne le
 * porte pas, il vient d'un `credentials.list` par coffre.
 */
export function toConfigRow<K extends ConfigKind>(
  kind: K,
  object: ConfigObjects[K],
  extra?: { credentialCount?: number }
): ConfigRow {
  // Le type générique `K` garantit que `object` est celui de `kind` ; TypeScript ne le suit pas dans le `switch`.
  switch (kind) {
    case 'agent': {
      const agent = object as BetaManagedAgentsAgent
      return { kind, id: agent.id, name: agent.name, summary: `${agent.model.id} · v${agent.version}` }
    }
    case 'environment': {
      const env = object as BetaEnvironment
      return { kind, id: env.id, name: env.name, summary: `${env.config.type} · ${networkMode(env)}` }
    }
    case 'memory_store': {
      const store = object as BetaManagedAgentsMemoryStore
      return { kind, id: store.id, name: store.name, summary: store.description || '' }
    }
    default: {
      const vault = object as BetaManagedAgentsVault
      const count = extra?.credentialCount
      return {
        kind,
        id: vault.id,
        name: vault.display_name,
        summary: count === undefined ? '' : plural(count, 'credential')
      }
    }
  }
}

/** Les lignes `memory_prefix` (marqueurs sans id) ne sont pas des mémoires. */
function isMemory(item: BetaManagedAgentsMemoryListItem): item is BetaManagedAgentsMemory {
  return item.type === 'memory'
}

/**
 * La liste plate des mémoires d'une banque, chemins complets. Sans `depth`, l'API liste toutes les
 * mémoires sous le préfixe (`depth` vaut 0 par défaut) : aucun `memory_prefix` n'est attendu, et
 * s'il en venait un il serait ignoré plutôt que rendu comme une mémoire.
 */
export function toMemoryRows(items: BetaManagedAgentsMemoryListItem[]): MemoryRow[] {
  return items.filter(isMemory).map((memory) => ({
    id: memory.id,
    path: memory.path,
    sizeBytes: memory.content_size_bytes,
    updatedAt: memory.updated_at
  }))
}

export function toMemoryContent(memory: BetaManagedAgentsMemory): MemoryContent {
  return {
    id: memory.id,
    memoryStoreId: memory.memory_store_id,
    path: memory.path,
    updatedAt: memory.updated_at,
    sha256: memory.content_sha256,
    content: clipBytes(memory.content ?? '', DETAIL_TEXT_LIMIT_BYTES)
  }
}

export function toMemoryStoreDetail(store: BetaManagedAgentsMemoryStore, memories: MemoryRow[]): MemoryStoreDetail {
  return {
    kind: 'memory_store',
    id: store.id,
    name: store.name,
    description: store.description || null,
    updatedAt: store.updated_at,
    form: { name: store.name, description: store.description ?? '' },
    memories
  }
}

function isBuiltinToolset(tool: BetaManagedAgentsAgent['tools'][number]): tool is BetaManagedAgentsAgentToolset20260401 {
  return tool.type === 'agent_toolset_20260401'
}

function isMcpToolset(tool: BetaManagedAgentsAgent['tools'][number]): tool is BetaManagedAgentsMCPToolset {
  return tool.type === 'mcp_toolset'
}

/** Une ligne de résumé du bloc `multiagent` : deux formes existent (`coordinator` et `multiagent_20261001`). */
function summarizeMultiagent(multiagent: NonNullable<BetaManagedAgentsAgent['multiagent']>): string {
  if (multiagent.type === 'coordinator') {
    const agents = multiagent.agents.filter((entry) => entry.type === 'agent').length
    const parts = [plural(agents, 'agent')]
    for (const entry of multiagent.agents) {
      if (entry.type === 'advisor') parts.push(`advisor ${entry.model}`)
    }
    return `Coordinator: ${parts.join(', ')}`
  }
  const parts: string[] = []
  if (multiagent.advisor.type === 'enabled') parts.push(`advisor ${multiagent.advisor.model}`)
  if (multiagent.subagents.type === 'enabled') {
    parts.push(`subagents (${multiagent.subagents.predefined_agents.length} predefined)`)
  }
  if (multiagent.workflows.type === 'enabled') {
    parts.push(`workflows (${multiagent.workflows.predefined_agents.length} predefined)`)
  }
  return `Multiagent: ${parts.length > 0 ? parts.join(', ') : 'all disabled'}`
}

export function toAgentDetail(agent: BetaManagedAgentsAgent): AgentDetail {
  const builtin = agent.tools.find(isBuiltinToolset)
  const mcpToolsets = agent.tools.filter(isMcpToolset)
  return {
    kind: 'agent',
    id: agent.id,
    name: agent.name,
    version: agent.version,
    form: toAgentForm(agent),
    model: agent.model.id,
    // `effort` est un objet `{ type: 'high' }` dans le SDK, pas une chaîne.
    effort: agent.model.effort?.type ?? null,
    description: agent.description,
    system: clipBytes(agent.system ?? '', DETAIL_TEXT_LIMIT_BYTES),
    builtinTools: builtin ? toolsetView(builtin.default_config, builtin.configs) : null,
    mcpServers: agent.mcp_servers.map((server) => {
      const toolset = mcpToolsets.find((candidate) => candidate.mcp_server_name === server.name)
      // Sans `mcp_toolset`, le serveur est déclaré mais n'expose aucun outil à l'agent.
      const view: ToolsetView = toolset
        ? toolsetView(toolset.default_config, toolset.configs)
        : { enabled: false, policy: null, overrides: [] }
      return { name: server.name, url: server.url, ...view }
    }),
    skills: agent.skills.map((skill) => skill.skill_id),
    multiagent: agent.multiagent ? summarizeMultiagent(agent.multiagent) : null,
    multiagentCoordinator: agent.multiagent?.type === 'coordinator'
  }
}

function toKeyValueItems(record: Record<string, string>): KeyValueItem[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

export function toEnvironmentDetail(env: BetaEnvironment): EnvironmentDetail {
  const common = {
    kind: 'environment' as const,
    id: env.id,
    name: env.name,
    description: env.description,
    updatedAt: env.updated_at,
    form: toEnvironmentForm(env),
    hosting: env.config.type
  }
  const metadata = toKeyValueItems(env.metadata)
  if (env.config.type !== 'cloud') {
    // `self_hosted` ne décrit ni réseau ni paquets : l'hôte les gère, et l'API n'en dit rien.
    return { ...common, network: { mode: 'host_managed' }, packages: [], metadata }
  }
  const { networking, packages } = env.config
  return {
    ...common,
    network:
      networking.type === 'limited'
        ? {
            mode: 'limited',
            allowedHosts: networking.allowed_hosts,
            allowPackageManagers: networking.allow_package_managers,
            allowMcpServers: networking.allow_mcp_servers
          }
        : { mode: 'unrestricted' },
    packages: PACKAGE_MANAGERS.filter((manager) => packages[manager].length > 0).map((manager) => ({
      key: manager,
      value: packages[manager].join(', ')
    })),
    metadata
  }
}

/** Un identifiant sans secret : seuls le type, le nom, l'URL du serveur MCP, l'expiration, l'horodatage et le formulaire (secrets vides) passent. */
function toCredentialRow(credential: BetaManagedAgentsCredential): CredentialRow {
  const { auth } = credential
  const fallbackName = auth.type === 'environment_variable' ? auth.secret_name : auth.mcp_server_url
  return {
    id: credential.id,
    name: credential.display_name || fallbackName,
    type: auth.type,
    mcpServerUrl: auth.type === 'environment_variable' ? null : auth.mcp_server_url,
    expiresAt: auth.type === 'mcp_oauth' ? (auth.expires_at ?? null) : null,
    updatedAt: credential.updated_at,
    form: toCredentialForm(credential)
  }
}

export function toVaultDetail(vault: BetaManagedAgentsVault, credentials: BetaManagedAgentsCredential[]): VaultDetail {
  return {
    kind: 'vault',
    id: vault.id,
    name: vault.display_name,
    updatedAt: vault.updated_at,
    form: { name: vault.display_name },
    credentials: credentials.filter((credential) => !credential.archived_at).map(toCredentialRow)
  }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = []
  for await (const item of items) all.push(item)
  return all
}

/** Les objets actifs d'un type, en lignes de liste. Les objets archivés sont écartés. */
async function listRows(client: Anthropic, kind: ConfigKind): Promise<ConfigRow[]> {
  switch (kind) {
    case 'agent':
      return (await collect(client.beta.agents.list()))
        .filter((agent) => !agent.archived_at)
        .map((agent) => toConfigRow('agent', agent))
    case 'environment':
      return (await collect(client.beta.environments.list()))
        .filter((env) => !env.archived_at)
        .map((env) => toConfigRow('environment', env))
    case 'memory_store':
      return (await collect(client.beta.memoryStores.list()))
        .filter((store) => !store.archived_at)
        .map((store) => toConfigRow('memory_store', store))
    case 'vault': {
      const vaults = (await collect(client.beta.vaults.list())).filter((vault) => !vault.archived_at)
      // Un `credentials.list` par coffre : l'API ne donne pas le nombre d'identifiants.
      return Promise.all(
        vaults.map(async (vault) => {
          const credentials = await collect(client.beta.vaults.credentials.list(vault.id))
          return toConfigRow('vault', vault, { credentialCount: credentials.filter((entry) => !entry.archived_at).length })
        })
      )
    }
  }
}

async function readDetail(client: Anthropic, kind: ConfigKind, id: string): Promise<ConfigDetail> {
  switch (kind) {
    case 'agent':
      return toAgentDetail(await client.beta.agents.retrieve(id))
    case 'environment':
      return toEnvironmentDetail(await client.beta.environments.retrieve(id))
    case 'memory_store': {
      const [store, items] = await Promise.all([
        client.beta.memoryStores.retrieve(id),
        collect(client.beta.memoryStores.memories.list(id))
      ])
      return toMemoryStoreDetail(store, toMemoryRows(items))
    }
    case 'vault': {
      const [vault, credentials] = await Promise.all([
        client.beta.vaults.retrieve(id),
        collect(client.beta.vaults.credentials.list(id))
      ])
      return toVaultDetail(vault, credentials)
    }
  }
}

export type ConfigHandlers = {
  list(input: { kind: ConfigKind }): Promise<ApiResult<ConfigRow[]>>
  detail(input: { kind: ConfigKind; id: string }): Promise<ApiResult<ConfigDetail>>
  readMemory(input: { memoryStoreId: string; memoryId: string }): Promise<ApiResult<MemoryContent>>
  formOptions(): Promise<ApiResult<CreateFormOptions>>
}

export function createConfigHandlers(store: ClientStore): ConfigHandlers {
  return {
    list: ({ kind }) => attempt(store, (client) => listRows(client, kind)),

    detail: ({ kind, id }) => attempt(store, (client) => readDetail(client, kind, id)),

    readMemory: ({ memoryStoreId, memoryId }) =>
      attempt(store, async (client) =>
        toMemoryContent(await client.beta.memoryStores.memories.retrieve(memoryId, { memory_store_id: memoryStoreId, view: 'full' }))
      ),

    formOptions: () =>
      attempt(store, async (client) => {
        const [agents, environments, vaults, memoryStores] = await Promise.all([
          listRows(client, 'agent'),
          listRows(client, 'environment'),
          listRows(client, 'vault'),
          listRows(client, 'memory_store')
        ])
        return { agents, environments, vaults, memoryStores }
      })
  }
}
