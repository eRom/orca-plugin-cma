// Le formulaire d'un agent, côté worker : l'agent de l'API en formulaire (`toAgentForm`), le formulaire reporté sur
// un document (`applyAgentForm`), puis la préparation de l'écriture. Le formulaire passe par le même document, le
// même différentiel et le même envoi que le brouillon YAML (`agent-drafts.ts`) : une seule règle de conflit.
import { isDeepStrictEqual } from 'node:util'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaManagedAgentsAgent,
  BetaManagedAgentsAgentToolset20260401,
  BetaManagedAgentsMCPToolset
} from '@anthropic-ai/sdk/resources/beta/agents/agents'
import {
  BUILTIN_TOOLS,
  MAX_SAVED_AGENTS,
  type AgentForm,
  type AgentToolsForm,
  type ApiResult,
  POLICY_LABELS,
  type Committed,
  type FieldChange,
  type MultiagentForm,
  type MultiagentMemberForm,
  type PreparedWrite,
  type ToolPolicy
} from '../protocol'
import { agentToDocument, type AgentDocument } from './agent-yaml'
import { agentVersionConflict, isVersionRefusal, sendAgent } from './agent-drafts'
import { failure, type ClientStore } from './client'
import { abbreviate, diffDocuments, leafChange } from './diff'
import type { PendingWrites } from './pending-writes'

type Tool = BetaManagedAgentsAgent['tools'][number]
type Mapping = Record<string, unknown>

const BUILTIN_TOOLSET = 'agent_toolset_20260401'
const MULTIAGENT_TYPE = 'multiagent_20261001'

const isBuiltinToolset = (tool: Tool): tool is BetaManagedAgentsAgentToolset20260401 => tool.type === BUILTIN_TOOLSET
const isMcpToolset = (tool: Tool): tool is BetaManagedAgentsMCPToolset => tool.type === 'mcp_toolset'

const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Un membre `subagents` ou `workflows` de la réponse de l'API ; désactivé, il vaut « inline agents permis, aucun agent enregistré ». */
function toMemberForm(
  member: { type: 'disabled' } | { type: 'enabled'; inline_agents: { type: string }; predefined_agents: { id: string; version: number }[] }
): MultiagentMemberForm {
  if (member.type === 'disabled') {
    return { enabled: false, inlineAgents: true, savedAgents: [] }
  }
  // La réponse rend toujours les références résolues (`self` revient avec l'identifiant du propriétaire) et épinglées.
  return {
    enabled: true,
    inlineAgents: member.inline_agents.type === 'enabled',
    savedAgents: member.predefined_agents.map((agent) => ({ id: agent.id, version: agent.version }))
  }
}

/** Le bloc `multiagent` du formulaire : seule la forme `multiagent_20261001` s'édite, la topologie `coordinator` reste au YAML. */
function toMultiagentForm(multiagent: BetaManagedAgentsAgent['multiagent']): MultiagentForm | null {
  if (!multiagent || multiagent.type !== MULTIAGENT_TYPE) {
    return null
  }
  return {
    advisor: multiagent.advisor.type === 'enabled' ? multiagent.advisor.model : null,
    subagents: toMemberForm(multiagent.subagents),
    workflows: toMemberForm(multiagent.workflows)
  }
}

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
    }),
    multiagent: toMultiagentForm(agent.multiagent)
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
 * Un membre `subagents` ou `workflows` écrit. Les agents enregistrés viennent du formulaire : une épingle conservée
 * repart à l'identique, un agent ajouté part sans version (l'API épingle alors la dernière).
 */
function memberValue(member: MultiagentMemberForm): Mapping {
  if (!member.enabled) {
    return { type: 'disabled' }
  }
  const predefined = member.savedAgents.map((agent) => (agent.version === null ? { type: 'agent', id: agent.id } : { type: 'agent', id: agent.id, version: agent.version }))
  return { type: 'enabled', inline_agents: { type: member.inlineAgents ? 'enabled' : 'disabled' }, predefined_agents: predefined }
}

const sameMember = (a: MultiagentMemberForm, b: MultiagentMemberForm): boolean =>
  a.enabled === b.enabled && a.inlineAgents === b.inlineAgents && isDeepStrictEqual(a.savedAgents, b.savedAgents)

/**
 * Le bloc `multiagent`, membre par membre. Un formulaire sans bloc retire celui de l'agent (la clé absente part à
 * `null`). Sinon le bloc du document, s'il est de type `multiagent_20261001`, est repris et seuls les membres qui
 * diffèrent de `base` sont réécrits ; un bloc neuf (ou une autre topologie) reçoit les trois membres.
 */
function applyMultiagent(doc: AgentDocument, form: MultiagentForm | null, base: MultiagentForm | null): void {
  if (form === null) {
    if (base !== null) {
      delete doc.multiagent
    }
    return
  }
  // Rien de changé dans le formulaire : le bloc de l'agent vivant passe tel quel, même s'il a changé ailleurs.
  if (base !== null && isDeepStrictEqual(form, base)) {
    return
  }
  const existing = isMapping(doc.multiagent) && doc.multiagent.type === MULTIAGENT_TYPE ? doc.multiagent : null
  const block: Mapping = existing === null ? { type: MULTIAGENT_TYPE } : { ...existing }
  const writeAll = existing === null || base === null
  if (writeAll || form.advisor !== base.advisor) {
    block.advisor = form.advisor === null ? { type: 'disabled' } : { type: 'enabled', model: form.advisor }
  }
  for (const name of ['subagents', 'workflows'] as const) {
    if (writeAll || !sameMember(form[name], base[name])) {
      block[name] = memberValue(form[name])
    }
  }
  doc.multiagent = block
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
  applyMultiagent(next, form.multiagent ?? null, base?.multiagent ?? null)
  if (Array.isArray(next.tools) && next.tools.length === 0 && !('tools' in doc)) {
    delete next.tools
  }
  return next
}

/** Le réglage d'un outil intégré en mots : `default` quand il hérite de tout, sinon ce qui est posé. */
function toolSettingText(setting: { enabled: boolean | null; policy: ToolPolicy | null }): string {
  const parts = [
    setting.enabled === null ? null : setting.enabled ? 'enabled' : 'disabled',
    setting.policy === null ? null : POLICY_LABELS[setting.policy]
  ].filter((part) => part !== null)
  return parts.length === 0 ? 'default' : parts.join(', ')
}

const toolsetText = (tools: AgentToolsForm): string => `${tools.enabled ? 'enabled' : 'disabled'}, ${POLICY_LABELS[tools.policy]}`

const serverText = (server: AgentForm['mcpServers'][number]): string => `${server.url}, ${POLICY_LABELS[server.policy]}`

/** Les réglages par outil qui diffèrent ; à la création, ceux qui sont posés. */
function toolChanges(form: AgentToolsForm, base: AgentToolsForm | null, out: FieldChange[]): void {
  for (const tool of form.tools) {
    const before = base?.tools.find((candidate) => candidate.name === tool.name) ?? { enabled: null, policy: null }
    if (before.enabled === tool.enabled && before.policy === tool.policy) {
      continue
    }
    out.push(leafChange(`Tool ${tool.name}`, toolSettingText(before), toolSettingText(tool)))
  }
}

function builtinChanges(form: AgentToolsForm | null, base: AgentToolsForm | null, out: FieldChange[]): void {
  if (form === null) {
    if (base !== null) {
      out.push({ path: 'Built-in tools', before: toolsetText(base), after: null, lines: null })
    }
    return
  }
  if (base === null) {
    out.push({ path: 'Built-in tools', before: null, after: toolsetText(form), lines: null })
  } else {
    if (form.enabled !== base.enabled) {
      out.push(leafChange('Built-in tools', base.enabled ? 'enabled' : 'disabled', form.enabled ? 'enabled' : 'disabled'))
    }
    if (form.policy !== base.policy) {
      out.push(leafChange('Built-in tools policy', POLICY_LABELS[base.policy], POLICY_LABELS[form.policy]))
    }
  }
  toolChanges(form, base, out)
}

function serverChanges(form: AgentForm['mcpServers'], base: AgentForm['mcpServers'], out: FieldChange[]): void {
  for (const server of form) {
    const before = base.find((candidate) => candidate.name === server.name)
    const path = `MCP server ${server.name}`
    if (!before) {
      out.push({ path, before: null, after: serverText(server), lines: null })
      continue
    }
    if (before.url !== server.url) {
      out.push(leafChange(`${path} URL`, before.url, server.url))
    }
    if (before.policy !== server.policy) {
      out.push(leafChange(`${path} policy`, POLICY_LABELS[before.policy], POLICY_LABELS[server.policy]))
    }
  }
  const kept = new Set(form.map((server) => server.name))
  for (const server of base) {
    if (!kept.has(server.name)) {
      out.push({ path: `MCP server ${server.name}`, before: serverText(server), after: null, lines: null })
    }
  }
}

const memberText = (member: MultiagentMemberForm): string => (!member.enabled ? 'disabled' : member.inlineAgents ? 'enabled' : 'enabled, no inline agents')

/** Le bloc en quelques mots : les membres activés, le conseiller avec son modèle. */
function multiagentText(multiagent: MultiagentForm): string {
  const parts: string[] = []
  if (multiagent.advisor !== null) parts.push(multiagent.advisor === '' ? 'advisor' : `advisor ${multiagent.advisor}`)
  if (multiagent.subagents.enabled) parts.push('subagents')
  if (multiagent.workflows.enabled) parts.push('workflows')
  return parts.length === 0 ? 'all disabled' : parts.join(', ')
}

/** Les agents enregistrés qu'un membre éteint emporte : l'API remplace l'objet du membre, la liste ne survit pas. */
const lostSaved = (member: MultiagentMemberForm | null, before: MultiagentMemberForm): number =>
  before.enabled && !(member?.enabled ?? false) ? before.savedAgents.length : 0

const removesText = (count: number): string => (count === 0 ? '' : ` (removes ${String(count)} saved agent${count === 1 ? '' : 's'})`)

/** Une ligne par agent enregistré ajouté ou retiré d'un membre qui reste activé (le worker n'a que les identifiants, pas les noms). */
function savedAgentChanges(path: string, form: MultiagentMemberForm, base: MultiagentMemberForm, out: FieldChange[]): void {
  const before = new Set(base.savedAgents.map((agent) => agent.id))
  const after = new Set(form.savedAgents.map((agent) => agent.id))
  for (const agent of form.savedAgents) {
    if (!before.has(agent.id)) {
      out.push({ path: `${path}${SAVED_AGENT_SUFFIX}`, before: null, after: agent.id, lines: null })
    }
  }
  for (const agent of base.savedAgents) {
    if (!after.has(agent.id)) {
      out.push({ path: `${path}${SAVED_AGENT_SUFFIX}`, before: agent.id, after: null, lines: null })
    }
  }
}

function memberChange(path: string, form: MultiagentMemberForm, base: MultiagentMemberForm, out: FieldChange[]): void {
  if (memberText(form) !== memberText(base)) {
    out.push(leafChange(path, memberText(base), `${memberText(form)}${removesText(lostSaved(form, base))}`))
  }
  // Un membre éteint n'a plus de liste : sa perte se lit dans le suffixe de la ligne d'état.
  if (form.enabled) {
    savedAgentChanges(path, form, base, out)
  }
}

function multiagentChanges(form: MultiagentForm | null, base: MultiagentForm | null, out: FieldChange[]): void {
  if (form === null) {
    if (base !== null) {
      const lost = lostSaved(null, base.subagents) + lostSaved(null, base.workflows)
      out.push({ path: `Multiagent${removesText(lost)}`, before: multiagentText(base), after: null, lines: null })
    }
    return
  }
  if (base === null) {
    out.push({ path: 'Multiagent', before: null, after: multiagentText(form), lines: null })
    return
  }
  if (form.advisor !== base.advisor) {
    out.push(leafChange('Advisor', base.advisor ?? 'disabled', form.advisor ?? 'disabled'))
  }
  memberChange('Subagents', form.subagents, base.subagents, out)
  memberChange('Workflows', form.workflows, base.workflows, out)
}

/**
 * La revue d'un formulaire, dans ses propres mots : une ligne par réglage que la personne a changé (tout ce qui est
 * posé, pour une création). Le différentiel du document en donnerait davantage (un serveur ajouté y amène aussi son
 * toolset) et en JSON brut. Mêmes règles que `applyAgentForm` : un effort `null` n'écrit rien, donc ne se montre pas.
 */
export function formChanges(form: AgentForm, base: AgentForm | null): FieldChange[] {
  const out: FieldChange[] = []
  const text = (path: string, before: string | null, after: string): void => {
    if (before !== after) {
      out.push(before === null ? { path, before: null, after: abbreviate(after), lines: null } : leafChange(path, before, after))
    }
  }
  text('Name', base?.name ?? null, form.name)
  text('Model', base?.model ?? null, form.model)
  if (form.effort !== null) {
    text('Effort', base === null ? null : (base.effort ?? 'default'), form.effort)
  }
  const description = base?.description ?? ''
  if (form.description !== description) {
    if (form.description === '') {
      out.push({ path: 'Description', before: abbreviate(description), after: null, lines: null })
    } else if (description === '') {
      out.push({ path: 'Description', before: null, after: abbreviate(form.description), lines: null })
    } else {
      out.push(leafChange('Description', description, form.description))
    }
  }
  builtinChanges(form.builtinTools, base?.builtinTools ?? null, out)
  serverChanges(form.mcpServers, base?.mcpServers ?? [], out)
  multiagentChanges(form.multiagent ?? null, base?.multiagent ?? null, out)
  return out
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

const SAVED_AGENT_SUFFIX = ' saved agent'

/**
 * Les lignes « … saved agent » de la revue disent le nom de l'agent, pas son identifiant : une lecture de la liste
 * des agents, seulement quand il y a de telles lignes. L'agent édité se dit « This agent » ; un échec de lecture
 * laisse les identifiants (la revue reste juste).
 */
async function nameSavedAgents(store: ClientStore, agentId: string | null, changes: FieldChange[]): Promise<FieldChange[]> {
  if (!changes.some((change) => change.path.endsWith(SAVED_AGENT_SUFFIX))) {
    return changes
  }
  const names = new Map<string, string>()
  try {
    for await (const agent of (await store.get()).beta.agents.list()) {
      names.set(agent.id, agent.name)
    }
  } catch {
    // Les identifiants restent : la revue est exacte, seulement moins lisible.
  }
  const nameOf = (id: string | null): string | null => (id === null ? null : id === agentId ? 'This agent' : (names.get(id) ?? id))
  return changes.map((change) =>
    change.path.endsWith(SAVED_AGENT_SUFFIX) ? { ...change, before: nameOf(change.before), after: nameOf(change.after) } : change
  )
}

export type PrepareAgentFormInput ={ agentId: string | null; baseVersion: number | null; form: AgentForm; base: AgentForm | null }

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
  if (form.multiagent?.advisor?.trim() === '') {
    return { ok: false, code: 'invalid', error: 'advisor model is required.' }
  }
  for (const [name, label] of [['subagents', 'Subagents'], ['workflows', 'Workflows']] as const) {
    const member = form.multiagent?.[name]
    if (member?.enabled && member.savedAgents.length > MAX_SAVED_AGENTS) {
      return { ok: false, code: 'invalid', error: `${label} can use at most ${String(MAX_SAVED_AGENTS)} saved agents.` }
    }
    if (member?.enabled && !member.inlineAgents && member.savedAgents.length === 0) {
      return { ok: false, code: 'invalid', error: `${label} need inline agents or at least one saved agent.` }
    }
  }
  try {
    let before: AgentDocument = {}
    let liveVersion: number | null = null
    if (agentId !== null) {
      // Un agent existant n'est jamais écrit sans la garde de la version que le formulaire a ouverte.
      if (baseVersion === null) {
        return { ok: false, code: 'other', error: 'The form lost its version: open the agent again.' }
      }
      const live = await (await store.get()).beta.agents.retrieve(agentId)
      before = agentToDocument(live)
      liveVersion = live.version
    }
    const after = applyAgentForm(before, form, agentId === null ? null : base)
    // Le document décide s'il y a quelque chose à envoyer.
    const documentChanges = diffDocuments(before, after)
    if (documentChanges.length === 0) {
      return { ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: you have not changed anything.' }
    }
    // La revue dit le formulaire tant que l'agent vivant est celui qu'il a ouvert : l'écart form/base est alors
    // exactement l'envoi. Changé ailleurs depuis, l'envoi (forcé par « Apply anyway ») peut porter plus que cet
    // écart (un toolset recréé, une politique déjà posée) : la revue montre alors le document, exact.
    const described = liveVersion === baseVersion ? formChanges(form, agentId === null ? null : base) : []
    const changes = await nameSavedAgents(store, agentId, described.length > 0 ? described : documentChanges)
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
