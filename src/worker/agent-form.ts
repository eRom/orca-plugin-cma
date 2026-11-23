// Le formulaire d'un agent, côté worker : l'agent de l'API en formulaire (`toAgentForm`), le formulaire reporté sur
// un document (`applyAgentForm`), puis la préparation de l'écriture. Le formulaire passe par le même document, le
// même différentiel et le même envoi que le brouillon YAML (`agent-drafts.ts`) : une seule règle de conflit.
import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaManagedAgentsAgent,
  BetaManagedAgentsAgentToolset20260401,
  BetaManagedAgentsMCPToolset
} from '@anthropic-ai/sdk/resources/beta/agents/agents'
import {
  BUILTIN_TOOLS,
  type AgentForm,
  type AgentToolsForm,
  type ApiResult,
  type Committed,
  type PreparedWrite,
  type ToolPolicy
} from '../protocol'
import { agentToDocument, type AgentDocument } from './agent-yaml'
import { agentVersionConflict, isVersionRefusal, sendAgent } from './agent-drafts'
import { failure, type ClientStore } from './client'
import { diffDocuments } from './diff'
import type { PendingWrites } from './pending-writes'

type Tool = BetaManagedAgentsAgent['tools'][number]
type Mapping = Record<string, unknown>

const BUILTIN_TOOLSET = 'agent_toolset_20260401'

const isBuiltinToolset = (tool: Tool): tool is BetaManagedAgentsAgentToolset20260401 => tool.type === BUILTIN_TOOLSET
const isMcpToolset = (tool: Tool): tool is BetaManagedAgentsMCPToolset => tool.type === 'mcp_toolset'

const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** L'agent de l'API tel que le formulaire le montre. Un outil sans entrée `configs` hérite du défaut : `null`, pas un réglage égal au défaut. */
export function toAgentForm(agent: BetaManagedAgentsAgent): AgentForm {
  const builtin = agent.tools.find(isBuiltinToolset)
  const mcpToolsets = agent.tools.filter(isMcpToolset)
  return {
    name: agent.name,
    model: agent.model.id,
    // `effort` est un objet `{ type: 'high' }` dans le SDK, pas une chaîne.
    effort: agent.model.effort?.type ?? null,
    description: agent.description ?? '',
    builtinTools: builtin
      ? {
          enabled: builtin.default_config.enabled,
          policy: builtin.default_config.permission_policy.type,
          tools: BUILTIN_TOOLS.map((name) => {
            const config = builtin.configs.find((candidate) => candidate.name === name)
            return { name, enabled: config ? config.enabled : null, policy: config ? config.permission_policy.type : null }
          })
        }
      : null,
    mcpServers: agent.mcp_servers.map((server) => {
      const toolset = mcpToolsets.find((candidate) => candidate.mcp_server_name === server.name)
      // Sans `mcp_toolset`, le serveur n'expose aucun outil : la politique du formulaire vaut la plus prudente.
      return { name: server.name, url: server.url, policy: toolset?.default_config.permission_policy.type ?? 'always_ask' }
    })
  }
}

/** Les outils du document, créés vides au besoin. */
function toolsOf(doc: AgentDocument): Mapping[] {
  if (!Array.isArray(doc.tools)) {
    doc.tools = []
  }
  return doc.tools as Mapping[]
}

/**
 * Le modèle et l'effort : `model.id` et `model.effort` (`{ type }`) ; les autres clés du modèle (`speed`, ...) restent.
 * Un effort `null` n'écrit rien : à la création, l'agent a l'effort par défaut ; sur une mise à jour, l'API garde la
 * valeur stockée quand elle est omise, et la rend toujours. Il n'y a donc pas de retour au défaut pour un agent existant.
 */
function applyModel(doc: AgentDocument, form: AgentForm, base: AgentForm | null): void {
  const modelChanged = base === null || form.model !== base.model
  const effortChanged = form.effort !== null && (base === null || form.effort !== base.effort)
  if (!modelChanged && !effortChanged) {
    return
  }
  const model: Mapping = isMapping(doc.model) ? { ...doc.model } : typeof doc.model === 'string' ? { id: doc.model } : {}
  if (modelChanged) {
    model.id = form.model
  }
  if (effortChanged) {
    model.effort = { type: form.effort }
  }
  doc.model = model
}

/** Le réglage d'un outil intégré : seuls les champs posés sont écrits ; sans réglage du tout, l'entrée disparaît. */
function applyToolSetting(configs: Mapping[], name: string, setting: { enabled: boolean | null; policy: ToolPolicy | null }): void {
  const index = configs.findIndex((entry) => entry.name === name)
  if (setting.enabled === null && setting.policy === null) {
    if (index >= 0) {
      configs.splice(index, 1)
    }
    return
  }
  const entry: Mapping = index >= 0 ? { ...configs[index] } : { name, type: name }
  if (setting.enabled === null) {
    delete entry.enabled
  } else {
    entry.enabled = setting.enabled
  }
  if (setting.policy === null) {
    delete entry.permission_policy
  } else {
    entry.permission_policy = { ...(isMapping(entry.permission_policy) ? entry.permission_policy : {}), type: setting.policy }
  }
  if (index >= 0) {
    configs[index] = entry
  } else {
    configs.push(entry)
  }
}

/** Le toolset intégré : créé, retiré ou mis à jour champ par champ, sans toucher aux outils que le formulaire n'a pas changés. */
function applyBuiltinTools(doc: AgentDocument, form: AgentToolsForm | null, base: AgentToolsForm | null): void {
  const tools = toolsOf(doc)
  const index = tools.findIndex((tool) => tool.type === BUILTIN_TOOLSET)
  if (form === null) {
    if (index >= 0 && base !== null) {
      tools.splice(index, 1)
    }
    return
  }
  const toolset: Mapping = index >= 0 ? { ...tools[index] } : { type: BUILTIN_TOOLSET }
  const defaults: Mapping = isMapping(toolset.default_config) ? { ...toolset.default_config } : {}
  if (base === null || form.enabled !== base.enabled) {
    defaults.enabled = form.enabled
  }
  if (base === null || form.policy !== base.policy) {
    defaults.permission_policy = { ...(isMapping(defaults.permission_policy) ? defaults.permission_policy : {}), type: form.policy }
  }
  toolset.default_config = defaults
  const configs: Mapping[] = Array.isArray(toolset.configs) ? [...(toolset.configs as Mapping[])] : []
  for (const tool of form.tools) {
    const before = base?.tools.find((candidate) => candidate.name === tool.name)
    if (before && before.enabled === tool.enabled && before.policy === tool.policy) {
      continue
    }
    applyToolSetting(configs, tool.name, tool)
  }
  if (configs.length > 0 || Array.isArray(toolset.configs)) {
    toolset.configs = configs
  }
  if (index >= 0) {
    tools[index] = toolset
  } else {
    // Un toolset ajouté passe devant ceux des serveurs, comme dans la console.
    tools.unshift(toolset)
  }
}

/** La politique par défaut d'un serveur : seule `default_config.permission_policy` change, les réglages par outil restent. */
function setServerPolicy(doc: AgentDocument, name: string, policy: ToolPolicy): void {
  const tools = toolsOf(doc)
  const index = tools.findIndex((tool) => tool.type === 'mcp_toolset' && tool.mcp_server_name === name)
  if (index < 0) {
    tools.push({ type: 'mcp_toolset', mcp_server_name: name, default_config: { enabled: true, permission_policy: { type: policy } } })
    return
  }
  const toolset: Mapping = { ...tools[index] }
  const defaults: Mapping = isMapping(toolset.default_config) ? { ...toolset.default_config } : { enabled: true }
  defaults.permission_policy = { ...(isMapping(defaults.permission_policy) ? defaults.permission_policy : {}), type: policy }
  toolset.default_config = defaults
  tools[index] = toolset
}

/** Les serveurs MCP : un serveur ajouté amène son toolset (politique envoyée explicitement), un serveur retiré emporte le sien. */
function applyMcpServers(doc: AgentDocument, form: AgentForm['mcpServers'], base: AgentForm['mcpServers']): void {
  const kept = new Set(form.map((server) => server.name))
  const removed = base.filter((server) => !kept.has(server.name)).map((server) => server.name)
  if (removed.length > 0) {
    if (Array.isArray(doc.mcp_servers)) {
      doc.mcp_servers = (doc.mcp_servers as Mapping[]).filter((server) => !removed.includes(String(server.name)))
    }
    doc.tools = toolsOf(doc).filter((tool) => !(tool.type === 'mcp_toolset' && removed.includes(String(tool.mcp_server_name))))
  }
  for (const server of form) {
    const before = base.find((candidate) => candidate.name === server.name)
    if (before && before.url === server.url && before.policy === server.policy) {
      continue
    }
    if (!before || before.url !== server.url) {
      const servers: Mapping[] = Array.isArray(doc.mcp_servers) ? [...(doc.mcp_servers as Mapping[])] : []
      const index = servers.findIndex((entry) => entry.name === server.name)
      if (index >= 0) {
        servers[index] = { ...servers[index], url: server.url }
      } else {
        servers.push({ name: server.name, type: 'url', url: server.url })
      }
      doc.mcp_servers = servers
    }
    if (!before || before.policy !== server.policy) {
      setServerPolicy(doc, server.name, server.policy)
    }
  }
}

/**
 * Le formulaire reporté sur un document : seul ce qui diffère de `base` est écrit (tout, pour une création, `base`
 * valant `null`). Le reste du document, y compris ce qu'un autre éditeur a changé, passe tel quel. Le document
 * reçu n'est pas modifié.
 */
export function applyAgentForm(doc: AgentDocument, form: AgentForm, base: AgentForm | null): AgentDocument {
  const next: AgentDocument = structuredClone(doc)
  if (base === null || form.name !== base.name) {
    next.name = form.name
  }
  applyModel(next, form, base)
  if (base === null ? form.description !== '' : form.description !== base.description) {
    // Une description vidée part à `null`, comme la console.
    next.description = form.description === '' ? null : form.description
  }
  applyBuiltinTools(next, form.builtinTools, base?.builtinTools ?? null)
  applyMcpServers(next, form.mcpServers, base?.mcpServers ?? [])
  if (Array.isArray(next.tools) && next.tools.length === 0 && !('tools' in doc)) {
    delete next.tools
  }
  return next
}

/** Les modèles que l'API propose (pagination parcourue). Un échec rend une liste vide : le panneau ajoute le modèle courant. */
export async function agentFormOptions(client: Anthropic, log: (message: string) => void = () => {}): Promise<{ models: string[] }> {
  try {
    const models: string[] = []
    for await (const model of client.models.list()) {
      models.push(model.id)
    }
    return { models }
  } catch (error) {
    log(`models could not be listed (${messageOf(error)}); the form offers the current model only`)
    return { models: [] }
  }
}

export type PrepareAgentFormInput = { agentId: string | null; baseVersion: number | null; form: AgentForm; base: AgentForm | null }

/**
 * Met en attente l'écriture d'un formulaire. La version n'est pas vérifiée ici : l'envoi porte celle que le
 * formulaire a ouverte (`baseVersion`), et un agent changé ailleurs est refusé au `write.commit` (`conflict`,
 * jeton gardé pour « Apply anyway »). Les changements du formulaire (l'écart `form` / `base`) s'appliquent sur
 * l'agent vivant, pas sur la version ouverte : l'aperçu et un envoi forcé ne portent que ce que la personne a
 * changé, et une clé de premier niveau partagée (`tools`) garde ce qu'un autre éditeur y a ajouté. Le brouillon
 * YAML suit l'autre règle (le document ouvert), parce qu'il envoie un fichier entier.
 */
export async function prepareAgentForm(
  store: ClientStore,
  pending: PendingWrites,
  input: PrepareAgentFormInput
): Promise<ApiResult<PreparedWrite>> {
  const { agentId, baseVersion, form, base } = input
  if (form.name.trim() === '') {
    return { ok: false, code: 'invalid', error: 'name is required.' }
  }
  if (form.model.trim() === '') {
    return { ok: false, code: 'invalid', error: 'model is required.' }
  }
  try {
    let before: AgentDocument = {}
    if (agentId !== null) {
      // Un agent existant n'est jamais écrit sans la garde de la version que le formulaire a ouverte.
      if (baseVersion === null) {
        return { ok: false, code: 'other', error: 'The form lost its version: open the agent again.' }
      }
      before = agentToDocument(await (await store.get()).beta.agents.retrieve(agentId))
    }
    const after = applyAgentForm(before, form, agentId === null ? null : base)
    const changes = diffDocuments(before, after)
    if (changes.length === 0) {
      return { ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: you have not changed anything.' }
    }
    const commit = async (force: boolean): Promise<ApiResult<Committed>> => {
      try {
        const agent = await sendAgent(await store.get(), agentId, baseVersion, before, after, force)
        return { ok: true, value: { label: `Applied, v${agent.version}`, id: agent.id } }
      } catch (error) {
        if (agentId !== null && baseVersion !== null && isVersionRefusal(error)) {
          return agentVersionConflict(store, agentId, baseVersion)
        }
        return failure(error)
      }
    }
    return { ok: true, value: pending.stage(commit, changes, agentId === null) }
  } catch (error) {
    return failure(error)
  }
}
