import Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { BUILTIN_TOOLS, type AgentForm, type ApiResult, type Committed, type PreparedWrite } from '../protocol'
import { agentToDocument, changedTopLevel, type AgentDocument } from './agent-yaml'
import { agentFormOptions, applyAgentForm, formChanges, prepareAgentForm, toAgentForm } from './agent-form'
import type { ClientStore } from './client'
import { diffDocuments } from './diff'
import { createPendingWrites } from './pending-writes'

// La fixture est la réponse réelle de l'API pour `Incident commander` (capturée le 22/11).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent.json', import.meta.url), 'utf8')) as BetaManagedAgentsAgent

const form = toAgentForm(fixture)
const doc = agentToDocument(fixture)

const LINEAR = { name: 'linear', url: 'https://mcp.linear.app/mcp', policy: 'always_ask' } as const

/** Les outils d'un document, vus comme des objets (le document est `Record<string, unknown>`). */
const toolsOf = (document: AgentDocument): Record<string, unknown>[] => document.tools as Record<string, unknown>[]

/** Le document tel que l'API le rend pour une version donnée de l'agent. */
const withForm = (changes: Partial<AgentForm>): AgentForm => ({ ...form, ...changes })

test('the form of the fixture lists the eight built-in tools in order, with the two explicit settings and the MCP server', () => {
  expect(form.name).toBe('Incident commander')
  expect(form.model).toBe('claude-haiku-5-5')
  expect(form.effort).toBe('high')
  expect(form.description).toBe('Triages incident ticket')
  expect(form.builtinTools?.enabled).toBe(true)
  expect(form.builtinTools?.policy).toBe('auto')
  expect(form.builtinTools?.tools.map((tool) => tool.name)).toEqual([...BUILTIN_TOOLS])
  for (const tool of form.builtinTools?.tools ?? []) {
    const explicit = tool.name === 'web_search' || tool.name === 'web_fetch'
    expect(tool.enabled).toBe(explicit ? false : null)
    expect(tool.policy).toBe(explicit ? 'auto' : null)
  }
  expect(form.mcpServers).toEqual([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', policy: 'always_ask' }])
})

test('an agent without a built-in toolset has no built-in form, and an MCP server without a toolset defaults to always_ask', () => {
  const bare = { ...fixture, tools: [] } as BetaManagedAgentsAgent
  expect(toAgentForm(bare).builtinTools).toBe(null)
  expect(toAgentForm(bare).mcpServers).toEqual([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', policy: 'always_ask' }])
  const noEffort = { ...fixture, description: null, model: { id: 'claude-haiku-5-5' } } as unknown as BetaManagedAgentsAgent
  expect(toAgentForm(noEffort).effort).toBe(null)
  expect(toAgentForm(noEffort).description).toBe('')
})

test('changing the default policy only changes the default policy and keeps both per-tool settings, url_sources included', () => {
  const after = applyAgentForm(doc, withForm({ builtinTools: { ...form.builtinTools!, policy: 'always_ask' } }), form)
  const changes = diffDocuments(doc, after)
  expect(changes.map((change) => change.path)).toEqual(['tools[0].default_config.permission_policy.type'])
  const configs = toolsOf(after)[0]?.configs as Record<string, unknown>[]
  expect(configs.map((config) => config.name)).toEqual(['web_search', 'web_fetch'])
  expect('url_sources' in (configs[1] as object)).toBe(true)
  // Le document de départ n'est pas modifié.
  expect(diffDocuments(doc, agentToDocument(fixture))).toEqual([])
})

test('adding a server adds its entry and a toolset with the policy sent explicitly', () => {
  const after = applyAgentForm(doc, withForm({ mcpServers: [...form.mcpServers, LINEAR] }), form)
  expect(after.mcp_servers).toEqual([
    { name: 'github', type: 'url', url: 'https://api.githubcopilot.com/mcp/' },
    { name: 'linear', type: 'url', url: 'https://mcp.linear.app/mcp' }
  ])
  expect(toolsOf(after)[2]).toEqual({
    type: 'mcp_toolset',
    mcp_server_name: 'linear',
    default_config: { enabled: true, permission_policy: { type: 'always_ask' } }
  })
  expect(diffDocuments(doc, after).map((change) => change.path)).toEqual(['mcp_servers[1]', 'tools[2]'])
})

test('removing a server removes its entry and its toolset, and nothing else', () => {
  const after = applyAgentForm(doc, withForm({ mcpServers: [] }), form)
  expect(after.mcp_servers).toEqual([])
  expect(toolsOf(after).map((tool) => tool.type)).toEqual(['agent_toolset_20260401'])
  expect(diffDocuments(doc, after).map((change) => change.path)).toEqual(['mcp_servers[0]', 'tools[1]'])
})

test('changing the policy of a server only changes the default config policy and keeps its per-tool settings', () => {
  const withConfigs: AgentDocument = structuredClone(doc)
  ;(toolsOf(withConfigs)[1] as { configs: unknown[] }).configs = [{ name: 'list_commits', enabled: true, permission_policy: { type: 'always_allow' } }]
  const after = applyAgentForm(withConfigs, withForm({ mcpServers: [{ ...form.mcpServers[0]!, policy: 'auto' }] }), form)
  expect(diffDocuments(withConfigs, after).map((change) => change.path)).toEqual(['tools[1].default_config.permission_policy.type'])
  expect((toolsOf(after)[1] as { configs: unknown[] }).configs).toEqual([{ name: 'list_commits', enabled: true, permission_policy: { type: 'always_allow' } }])
})

test('model and effort rewrite model.id and model.effort as { type }, and keep the other model keys', () => {
  const after = applyAgentForm(doc, withForm({ model: 'claude-opus-5-5', effort: 'low' }), form)
  expect(after.model).toEqual({ id: 'claude-opus-5-5', effort: { type: 'low' }, speed: 'standard' })
  const effortOnly = applyAgentForm(doc, withForm({ effort: 'max' }), form)
  expect(diffDocuments(doc, effortOnly).map((change) => change.path)).toEqual(['model.effort.type'])
})

test('an existing agent has no way back to a default effort: a null effort in the form changes nothing', async () => {
  // L'API garde l'effort stocké quand il est omis à la mise à jour, et le rend toujours : « Default » n'existe qu'à la création.
  const cleared = applyAgentForm(doc, withForm({ effort: null }), form)
  expect(diffDocuments(doc, cleared)).toEqual([])
  expect(cleared.model).toEqual({ id: 'claude-haiku-5-5', effort: { type: 'high' }, speed: 'standard' })
  const { prepare } = setup()
  expect(await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ effort: null }), base: form })).toEqual({
    ok: false,
    code: 'nothing_to_apply',
    error: 'Nothing to apply: you have not changed anything.'
  })
  // Avec un autre changement, l'effort stocké part tel quel : jamais effacé.
  const withModel = applyAgentForm(doc, withForm({ model: 'claude-opus-5-5', effort: null }), form)
  expect(withModel.model).toEqual({ id: 'claude-opus-5-5', effort: { type: 'high' }, speed: 'standard' })
})

test('a per-tool setting writes an entry with only the fields that are set, keeps the other fields of an existing one, and drops an entry that inherits again', () => {
  const tools = form.builtinTools!.tools.map((tool) => {
    if (tool.name === 'bash') return { ...tool, enabled: true }
    if (tool.name === 'read') return { ...tool, policy: 'always_ask' as const }
    if (tool.name === 'web_fetch') return { ...tool, enabled: true }
    if (tool.name === 'web_search') return { ...tool, enabled: null, policy: null }
    return tool
  })
  const after = applyAgentForm(doc, withForm({ builtinTools: { ...form.builtinTools!, tools } }), form)
  const configs = toolsOf(after)[0]?.configs as Record<string, unknown>[]
  expect(configs).toEqual([
    { enabled: true, name: 'web_fetch', permission_policy: { type: 'auto' }, type: 'web_fetch', url_sources: null },
    { name: 'bash', type: 'bash', enabled: true },
    { name: 'read', type: 'read', permission_policy: { type: 'always_ask' } }
  ])
})

test('only what differs from the base is applied: a live change to another key survives', () => {
  const live: AgentDocument = { ...structuredClone(doc), system: 'Changed in the console.' }
  const after = applyAgentForm(live, withForm({ description: 'My new description' }), form)
  expect(diffDocuments(live, after).map((change) => change.path)).toEqual(['description'])
  expect(after.system).toBe('Changed in the console.')
  // Une description vidée part à `null`, comme la console.
  expect(applyAgentForm(live, withForm({ description: '' }), form).description).toBe(null)
})

test('a creation writes everything the form carries and nothing it leaves empty', () => {
  const created = applyAgentForm({}, { ...form, description: '', mcpServers: [LINEAR] }, null)
  expect(created).toEqual({
    name: 'Incident commander',
    model: { id: 'claude-haiku-5-5', effort: { type: 'high' } },
    tools: [
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'auto' } },
        configs: [
          { name: 'web_fetch', type: 'web_fetch', enabled: false, permission_policy: { type: 'auto' } },
          { name: 'web_search', type: 'web_search', enabled: false, permission_policy: { type: 'auto' } }
        ]
      },
      { type: 'mcp_toolset', mcp_server_name: 'linear', default_config: { enabled: true, permission_policy: { type: 'always_ask' } } }
    ],
    mcp_servers: [{ name: 'linear', type: 'url', url: 'https://mcp.linear.app/mcp' }]
  })
  const bare = applyAgentForm({}, { name: 'x', model: 'claude-haiku-5-5', effort: null, description: 'd', builtinTools: null, mcpServers: [], multiagent: null, skills: [] }, null)
  expect(bare).toEqual({ name: 'x', model: { id: 'claude-haiku-5-5' }, description: 'd' })
})

// --- Le faux client : une garde de version comme celle de l'API, et un historique des versions ---

type Call = { method: string; args: unknown[] }
type AgentRecord = Record<string, unknown> & { id: string; version: number }

const VERSION_REFUSAL_BODY = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'Concurrent modification detected. Please fetch the latest version and retry.' },
  request_id: 'req_test'
}

function fakeApi() {
  const calls: Call[] = []
  const agents = new Map<string, AgentRecord>()
  const history = new Map<string, AgentRecord>()
  agents.set('agent_1', { ...structuredClone(fixture), id: 'agent_1' } as unknown as AgentRecord)
  const notFound = (id: string): Error =>
    new Anthropic.NotFoundError(404, { type: 'error', error: { type: 'not_found_error', message: id } }, undefined, new Headers())
  const api = {
    list: async function* () {
      calls.push({ method: 'agents.list', args: [] })
      for (const agent of agents.values()) yield structuredClone(agent)
    },
    retrieve: async (id: string, params?: { version?: number }) => {
      calls.push({ method: 'agents.retrieve', args: [id, params] })
      const agent = agents.get(id)
      if (!agent) throw notFound(id)
      if (params?.version !== undefined && params.version !== agent.version) {
        const past = history.get(`${id}@${params.version}`)
        if (!past) throw notFound(`${id}@${params.version}`)
        return structuredClone(past)
      }
      return structuredClone(agent)
    },
    create: async (params: Record<string, unknown>) => {
      calls.push({ method: 'agents.create', args: [params] })
      const agent = { ...structuredClone(fixture), ...params, id: 'agent_created', version: 1 } as unknown as AgentRecord
      agents.set(agent.id, agent)
      return structuredClone(agent)
    },
    update: async (id: string, params: Record<string, unknown>) => {
      calls.push({ method: 'agents.update', args: [id, params] })
      const agent = agents.get(id)
      if (!agent) throw notFound(id)
      if (params.version !== undefined && params.version !== agent.version) {
        throw new Anthropic.ConflictError(409, VERSION_REFUSAL_BODY, undefined, new Headers())
      }
      const { version: _version, ...rest } = params
      history.set(`${id}@${agent.version}`, structuredClone(agent))
      const next = { ...agent, ...rest, version: agent.version + 1 } as AgentRecord
      agents.set(id, next)
      return structuredClone(next)
    }
  }
  const store = { get: async () => ({ beta: { agents: api } }), reset() {}, hasKey: async () => true } as unknown as ClientStore
  /** Un autre éditeur (la console) modifie l'agent : une mise à jour sans garde, qui monte la version. */
  const elsewhere = async (patch: Record<string, unknown>): Promise<void> => {
    await api.update('agent_1', patch)
    calls.pop()
  }
  return { store, calls, agents, elsewhere }
}

function setup() {
  const api = fakeApi()
  const pending = createPendingWrites(() => 0)
  const prepare = (input: Parameters<typeof prepareAgentForm>[2]): Promise<ApiResult<PreparedWrite>> => prepareAgentForm(api.store, pending, input)
  return { api, pending, prepare }
}

const only = (calls: Call[], method: string): Call[] => calls.filter((call) => call.method === method)
const commitOf = async (pending: ReturnType<typeof setup>['pending'], prepared: ApiResult<PreparedWrite>, force: boolean): Promise<ApiResult<Committed>> => {
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.error}`)
  return pending.commit(prepared.value.token, force)
}

const POLICY_CHANGE = withForm({ builtinTools: { ...form.builtinTools!, policy: 'always_ask' } })

test('prepareAgentForm stages an update guarded by the opened version, with only the touched keys', async () => {
  const { api, pending, prepare } = setup()
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: POLICY_CHANGE, base: form })
  expect(prepared.ok && prepared.value.creates).toBe(false)
  expect(prepared.ok && prepared.value.changes.map((change) => change.path)).toEqual(['Built-in tools policy'])
  // Rien n'est écrit tant que le jeton n'est pas confirmé.
  expect(only(api.calls, 'agents.update').length).toBe(0)
  expect(await commitOf(pending, prepared, false)).toEqual({ ok: true, value: { label: 'Applied, v6', id: 'agent_1' } })
  const params = only(api.calls, 'agents.update')[0]?.args[1] as Record<string, unknown>
  expect(Object.keys(params).sort()).toEqual(['tools', 'version'])
  expect(params.version).toBe(5)
})

test('with a stale version the token is a conflict, and a forced commit sends no version and only the keys the form touched', async () => {
  const { api, pending, prepare } = setup()
  // Le formulaire a été ouvert à la v5 ; la console change la description (v6), puis Romain prépare.
  await api.elsewhere({ description: 'Changed in the console.' })
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: POLICY_CHANGE, base: form })
  // La préparation ne vérifie pas la version : le jeton existe, et le récapitulatif ne montre que la politique.
  expect(prepared.ok && prepared.value.changes.map((change) => change.path)).toEqual(['tools[0].default_config.permission_policy.type'])
  expect(await commitOf(pending, prepared, false)).toEqual({ ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it (v5 → v6).' })
  expect(only(api.calls, 'agents.update').length).toBe(1)
  // Le jeton survit : « Apply anyway ».
  expect(await commitOf(pending, prepared, true)).toEqual({ ok: true, value: { label: 'Applied, v7', id: 'agent_1' } })
  const forced = only(api.calls, 'agents.update')[1]?.args[1] as Record<string, unknown>
  expect('version' in forced).toBe(false)
  expect(Object.keys(forced)).toEqual(['tools'])
  expect(api.agents.get('agent_1')?.description).toBe('Changed in the console.')
})

test('I1: the changes are applied onto the live agent, so a forced send keeps a per-tool setting added elsewhere on the same key', async () => {
  const { api, pending, prepare } = setup()
  // Le formulaire est ouvert à la v5 ; la politique de github change dans le formulaire. Entre-temps (v6), le YAML
  // d'un autre éditeur ajoute un réglage par outil sur le toolset de github : la même clé `tools`.
  const [builtin, github] = structuredClone(api.agents.get('agent_1')!.tools) as Record<string, unknown>[]
  const setting = { name: 'list_commits', enabled: true, permission_policy: { type: 'always_allow' } }
  await api.elsewhere({ tools: [builtin, { ...github, configs: [setting] }] })
  const prepared = await prepare({
    agentId: 'agent_1',
    baseVersion: 5,
    form: withForm({ mcpServers: [{ ...form.mcpServers[0]!, policy: 'auto' }] }),
    base: form
  })
  // L'agent a changé depuis l'ouverture : l'aperçu est le document exact, calculé sur l'agent vivant, et ne montre que la politique.
  expect(prepared.ok && prepared.value.changes.map((change) => change.path)).toEqual(['tools[1].default_config.permission_policy.type'])
  expect(await commitOf(pending, prepared, false)).toEqual({ ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it (v5 → v6).' })
  expect(await commitOf(pending, prepared, true)).toEqual({ ok: true, value: { label: 'Applied, v7', id: 'agent_1' } })
  const stored = api.agents.get('agent_1')!.tools as Record<string, unknown>[]
  const saved = stored[1] as { configs: unknown[]; default_config: { permission_policy: { type: string } } }
  expect(saved.default_config.permission_policy.type).toBe('auto')
  expect(saved.configs).toEqual([setting])
})

test('a guarded send of the form still carries the opened version, and reads the live agent once', async () => {
  const { api, pending, prepare } = setup()
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: POLICY_CHANGE, base: form })
  expect(only(api.calls, 'agents.retrieve').map((call) => call.args)).toEqual([['agent_1', undefined]])
  await commitOf(pending, prepared, false)
  expect((only(api.calls, 'agents.update')[0]?.args[1] as Record<string, unknown>).version).toBe(5)
})

test('an unchanged form has nothing to apply, and an existing agent is never prepared without the version the form opened', async () => {
  const { prepare } = setup()
  expect(await prepare({ agentId: 'agent_1', baseVersion: 5, form, base: form })).toEqual({
    ok: false,
    code: 'nothing_to_apply',
    error: 'Nothing to apply: you have not changed anything.'
  })
  const unguarded = await prepare({ agentId: 'agent_1', baseVersion: null, form: POLICY_CHANGE, base: form })
  expect(unguarded.ok).toBe(false)
})

test('a form without a name or a model is refused before any call', async () => {
  const { api, prepare } = setup()
  expect(await prepare({ agentId: null, baseVersion: null, form: withForm({ name: '  ' }), base: null })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'name is required.'
  })
  expect(await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ model: '' }), base: form })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'model is required.'
  })
  expect(api.calls.length).toBe(0)
})

test('a creation stages a create with the whole form, without reading any agent', async () => {
  const { api, pending, prepare } = setup()
  const prepared = await prepare({ agentId: null, baseVersion: null, form: { ...form, name: 'plugin-test-agent' }, base: null })
  expect(prepared.ok && prepared.value.creates).toBe(true)
  expect(only(api.calls, 'agents.retrieve').length).toBe(0)
  expect(await commitOf(pending, prepared, false)).toEqual({ ok: true, value: { label: 'Applied, v1', id: 'agent_created' } })
  const params = only(api.calls, 'agents.create')[0]?.args[0] as Record<string, unknown>
  expect(params.name).toBe('plugin-test-agent')
  expect('version' in params).toBe(false)
})

// --- Les modèles proposés ---

const pages = (...ids: string[]) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const id of ids) yield { id }
  }
})

test('agentFormOptions lists every model id across the pages, and falls back to an empty list when the call fails', async () => {
  const client = { models: { list: () => pages('claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5') } } as unknown as Anthropic
  expect(await agentFormOptions(client)).toEqual({ models: ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'] })
  const failing = {
    models: {
      list: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield { id: 'claude-opus-5-5' }
          throw new Error('boom')
        }
      })
    }
  } as unknown as Anthropic
  const logs: string[] = []
  expect(await agentFormOptions(failing, (message) => logs.push(message))).toEqual({ models: [] })
  expect(logs.length).toBe(1)
})

// --- La revue d'un formulaire ---

const summary = (changes: { path: string; before: string | null; after: string | null }[]) =>
  changes.map(({ path, before, after }) => ({ path, before, after }))

test('AC-5 replay: adding a server and changing the default policy reviews as exactly those two changes, in words', async () => {
  const { prepare } = setup()
  const changed = withForm({ builtinTools: { ...form.builtinTools!, policy: 'always_ask' }, mcpServers: [...form.mcpServers, LINEAR] })
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: changed, base: form })
  expect(prepared.ok && summary(prepared.value.changes)).toEqual([
    { path: 'Built-in tools policy', before: 'auto', after: 'always ask' },
    { path: 'MCP server linear', before: null, after: 'https://mcp.linear.app/mcp, always ask' }
  ])
  expect(prepared.ok && prepared.value.totalChanges).toBe(2)
})

test('a removed server, a changed url and a per-tool setting each read as one line', () => {
  const tools = form.builtinTools!.tools.map((tool) => (tool.name === 'bash' ? { ...tool, enabled: false } : tool.name === 'web_search' ? { ...tool, enabled: null, policy: null } : tool))
  const changed = withForm({ builtinTools: { ...form.builtinTools!, tools }, mcpServers: [{ ...form.mcpServers[0]!, url: 'https://example.com/mcp' }] })
  expect(summary(formChanges(changed, form))).toEqual([
    { path: 'Tool bash', before: 'default', after: 'disabled' },
    { path: 'Tool web_search', before: 'disabled, auto', after: 'default' },
    { path: 'MCP server github URL', before: 'https://api.githubcopilot.com/mcp/', after: 'https://example.com/mcp' }
  ])
  expect(summary(formChanges(withForm({ mcpServers: [] }), form))).toEqual([
    { path: 'MCP server github', before: 'https://api.githubcopilot.com/mcp/, always ask', after: null }
  ])
})

test('a creation reviews what is set, and leaves out a default effort and an empty description', () => {
  const created: AgentForm = { ...form, effort: null, description: '', builtinTools: { enabled: true, policy: 'auto', tools: form.builtinTools!.tools.map((tool) => ({ ...tool, enabled: null, policy: null })) }, mcpServers: [] }
  expect(summary(formChanges(created, null))).toEqual([
    { path: 'Name', before: null, after: 'Incident commander' },
    { path: 'Model', before: null, after: 'claude-haiku-5-5' },
    { path: 'Built-in tools', before: null, after: 'enabled, auto' }
  ])
})

test('a null effort on an existing agent is not reviewed, as it is not sent', () => {
  expect(formChanges(withForm({ effort: null }), form)).toEqual([])
  expect(summary(formChanges(withForm({ effort: 'low', description: '' }), form))).toEqual([
    { path: 'Effort', before: 'high', after: 'low' },
    { path: 'Description', before: 'Triages incident ticket', after: null }
  ])
})

test('review I-1: a built-in toolset removed elsewhere is recreated by a rename, and the review says so instead of showing only the name', async () => {
  const { api, prepare } = setup()
  const [, github] = structuredClone(api.agents.get('agent_1')!.tools) as Record<string, unknown>[]
  await api.elsewhere({ tools: [github] })
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ name: 'Renamed' }), base: form })
  const paths = prepared.ok ? prepared.value.changes.map((change) => change.path) : []
  expect(paths.includes('name')).toBe(true)
  expect(paths.some((path) => path.startsWith('tools'))).toBe(true)
})

// --- Le bloc multiagent ---

// SYNTHÉTIQUES, jamais observés : aucun agent multiagent n'existe dans le workspace de test.
const PREDEFINED = [{ type: 'agent', id: 'agent_helper', version: 2 }]

const withBlock = (multiagent: unknown): BetaManagedAgentsAgent => ({ ...structuredClone(fixture), multiagent }) as unknown as BetaManagedAgentsAgent

const ENABLED_BLOCK = {
  type: 'multiagent_20261001',
  advisor: { type: 'enabled', model: 'claude-fable-5-2' },
  subagents: { type: 'enabled', inline_agents: { type: 'disabled' }, predefined_agents: PREDEFINED },
  workflows: { type: 'disabled' }
}

const blockAgent = withBlock(ENABLED_BLOCK)
const blockForm = toAgentForm(blockAgent)
const blockDoc = agentToDocument(blockAgent)

const ALL_OFF = { advisor: null, subagents: { enabled: false, inlineAgents: true, savedAgents: [] }, workflows: { enabled: false, inlineAgents: true, savedAgents: [] } }

test('the multiagent block maps to the form, a disabled member reads as off, and a coordinator or no block is no form', () => {
  expect(form.multiagent).toBe(null)
  expect(blockForm.multiagent).toEqual({
    advisor: 'claude-fable-5-2',
    subagents: { enabled: true, inlineAgents: false, savedAgents: [{ id: 'agent_helper', version: 2 }] },
    workflows: { enabled: false, inlineAgents: true, savedAgents: [] }
  })
  const coordinator = withBlock({ type: 'coordinator', agents: [{ type: 'self' }] })
  expect(toAgentForm(coordinator).multiagent).toBe(null)
  const disabled = withBlock({ type: 'multiagent_20261001', advisor: { type: 'disabled' }, subagents: { type: 'disabled' }, workflows: { type: 'disabled' } })
  expect(toAgentForm(disabled).multiagent).toEqual(ALL_OFF)
})

test('an unchanged multiagent form changes nothing, whether the block has members on or all off', () => {
  expect(diffDocuments(blockDoc, applyAgentForm(blockDoc, blockForm, blockForm))).toEqual([])
  const off = withBlock({ type: 'multiagent_20261001', advisor: { type: 'disabled' }, subagents: { type: 'disabled' }, workflows: { type: 'disabled' } })
  expect(diffDocuments(agentToDocument(off), applyAgentForm(agentToDocument(off), toAgentForm(off), toAgentForm(off)))).toEqual([])
})

test('adding a block to an agent without one writes the three members, and the unset ones as disabled', () => {
  const added = withForm({ multiagent: { ...ALL_OFF, subagents: { enabled: true, inlineAgents: true, savedAgents: [] } } })
  const after = applyAgentForm(doc, added, form)
  expect(after.multiagent).toEqual({
    type: 'multiagent_20261001',
    advisor: { type: 'disabled' },
    subagents: { type: 'enabled', inline_agents: { type: 'enabled' }, predefined_agents: [] },
    workflows: { type: 'disabled' }
  })
  expect(diffDocuments(doc, after).map((change) => change.path)).toEqual(['multiagent'])
})

test('removing the block drops the key, which the update sends as null', () => {
  const after = applyAgentForm(blockDoc, withForm({ multiagent: null }), blockForm)
  expect('multiagent' in after).toBe(false)
  expect(changedTopLevel(blockDoc, after)).toEqual({ multiagent: null })
  // Sans bloc de part et d'autre, rien n'est écrit, même sur un agent dont le bloc est un coordinator.
  const coordinatorDoc = agentToDocument(withBlock({ type: 'coordinator', agents: [{ type: 'self' }] }))
  expect(applyAgentForm(coordinatorDoc, form, form).multiagent).toEqual(coordinatorDoc.multiagent)
})

test('changing the advisor or the inline option keeps the predefined agents of subagents, and turning the member off drops them', () => {
  const advisor = applyAgentForm(blockDoc, { ...blockForm, multiagent: { ...blockForm.multiagent!, advisor: 'claude-opus-5-5' } }, blockForm)
  expect(advisor.multiagent).toEqual({ ...ENABLED_BLOCK, advisor: { type: 'enabled', model: 'claude-opus-5-5' } })
  expect(diffDocuments(blockDoc, advisor).map((change) => change.path)).toEqual(['multiagent.advisor.model'])
  // L'option « inline agents » change, la liste enregistrée reste.
  const inline = applyAgentForm(blockDoc, { ...blockForm, multiagent: { ...blockForm.multiagent!, subagents: { ...blockForm.multiagent!.subagents, inlineAgents: true } } }, blockForm)
  const subagents = (inline.multiagent as { subagents: unknown }).subagents
  expect(subagents).toEqual({ type: 'enabled', inline_agents: { type: 'enabled' }, predefined_agents: PREDEFINED })
  // Un membre éteint perd sa liste (le YAML la réécrit au besoin).
  const off = applyAgentForm(blockDoc, { ...blockForm, multiagent: { ...blockForm.multiagent!, subagents: ALL_OFF.subagents } }, blockForm)
  expect((off.multiagent as { subagents: unknown }).subagents).toEqual({ type: 'disabled' })
})

test('a change made elsewhere on another member survives: only the members that differ from the base are written', () => {
  const live = structuredClone(blockDoc)
  ;(live.multiagent as Record<string, unknown>).workflows = { type: 'enabled', inline_agents: { type: 'enabled' }, predefined_agents: [] }
  const after = applyAgentForm(live, { ...blockForm, multiagent: { ...blockForm.multiagent!, advisor: null } }, blockForm)
  expect(diffDocuments(live, after).map((change) => change.path)).toEqual(['multiagent.advisor.type', 'multiagent.advisor.model'])
  expect((after.multiagent as { workflows: unknown }).workflows).toEqual({ type: 'enabled', inline_agents: { type: 'enabled' }, predefined_agents: [] })
})

test('a creation writes the full block', () => {
  const created = applyAgentForm({}, { ...form, builtinTools: null, mcpServers: [], multiagent: { ...ALL_OFF, advisor: 'claude-fable-5-2', workflows: { enabled: true, inlineAgents: false, savedAgents: [] } } }, null)
  expect(created.multiagent).toEqual({
    type: 'multiagent_20261001',
    advisor: { type: 'enabled', model: 'claude-fable-5-2' },
    subagents: { type: 'disabled' },
    workflows: { type: 'enabled', inline_agents: { type: 'disabled' }, predefined_agents: [] }
  })
})

// --- Les agents enregistrés d'un membre ---

/** Un bloc à deux membres allumés, avec des agents enregistrés épinglés de part et d'autre. */
const TWO_MEMBERS = {
  type: 'multiagent_20261001',
  advisor: { type: 'disabled' },
  subagents: { type: 'enabled', inline_agents: { type: 'enabled' }, predefined_agents: [{ type: 'agent', id: 'agent_a', version: 3 }, { type: 'agent', id: 'agent_b', version: 1 }] },
  workflows: { type: 'enabled', inline_agents: { type: 'enabled' }, predefined_agents: [{ type: 'agent', id: 'agent_c', version: 7 }] }
}
const twoAgent = withBlock(TWO_MEMBERS)
const twoForm = toAgentForm(twoAgent)
const twoDoc = agentToDocument(twoAgent)

/** Le formulaire de deux membres, avec les agents enregistrés d'un membre remplacés. */
const withSaved = (name: 'subagents' | 'workflows', savedAgents: { id: string; version: number | null }[]): AgentForm => ({
  ...twoForm,
  multiagent: { ...twoForm.multiagent!, [name]: { ...twoForm.multiagent![name], savedAgents } }
})

const predefinedOf = (document: AgentDocument, name: 'subagents' | 'workflows'): unknown =>
  ((document.multiagent as Record<string, Record<string, unknown>>)[name] as Record<string, unknown>).predefined_agents

test('the saved agents of the response map to the form with their pinned versions', () => {
  expect(twoForm.multiagent?.subagents.savedAgents).toEqual([
    { id: 'agent_a', version: 3 },
    { id: 'agent_b', version: 1 }
  ])
  expect(twoForm.multiagent?.workflows.savedAgents).toEqual([{ id: 'agent_c', version: 7 }])
})

test('AC-3: an unchanged form with saved agents writes nothing, and a change elsewhere in the block sends the pins back identical', () => {
  expect(diffDocuments(twoDoc, applyAgentForm(twoDoc, twoForm, twoForm))).toEqual([])
  // Seul « inline » de workflows change : subagents n'est pas réécrit, workflows repart avec son épingle.
  const inline = { ...twoForm, multiagent: { ...twoForm.multiagent!, workflows: { ...twoForm.multiagent!.workflows, inlineAgents: false } } }
  const after = applyAgentForm(twoDoc, inline, twoForm)
  expect(predefinedOf(after, 'workflows')).toEqual([{ type: 'agent', id: 'agent_c', version: 7 }])
  expect(predefinedOf(after, 'subagents')).toEqual(predefinedOf(twoDoc, 'subagents'))
  expect(diffDocuments(twoDoc, after).map((change) => change.path)).toEqual(['multiagent.workflows.inline_agents.type'])
})

test('AC-1 and AC-2: an added saved agent is written without a version and leaves the other member untouched', () => {
  const after = applyAgentForm(twoDoc, withSaved('subagents', [...twoForm.multiagent!.subagents.savedAgents, { id: 'agent_new', version: null }]), twoForm)
  expect(predefinedOf(after, 'subagents')).toEqual([
    { type: 'agent', id: 'agent_a', version: 3 },
    { type: 'agent', id: 'agent_b', version: 1 },
    { type: 'agent', id: 'agent_new' }
  ])
  expect(predefinedOf(after, 'workflows')).toEqual(predefinedOf(twoDoc, 'workflows'))
  expect(diffDocuments(twoDoc, after).map((change) => change.path)).toEqual(['multiagent.subagents.predefined_agents[2]'])
})

test('removing one saved agent drops only that one and keeps the pins of the others', () => {
  const after = applyAgentForm(twoDoc, withSaved('subagents', [{ id: 'agent_b', version: 1 }]), twoForm)
  expect(predefinedOf(after, 'subagents')).toEqual([{ type: 'agent', id: 'agent_b', version: 1 }])
  expect(predefinedOf(after, 'workflows')).toEqual(predefinedOf(twoDoc, 'workflows'))
})

test('prepareAgentForm refuses more than 20 saved agents, and accepts exactly 20', async () => {
  const { prepare } = setup()
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `agent_${String(index)}`, version: null }))
  expect(await prepare({ agentId: 'agent_1', baseVersion: 5, form: withSaved('workflows', many(21)), base: form })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Workflows can use at most 20 saved agents.'
  })
  expect((await prepare({ agentId: 'agent_1', baseVersion: 5, form: withSaved('subagents', many(20)), base: form })).ok).toBe(true)
})

test('a new block lists its saved agents in the review, not only the block line', () => {
  const added = withForm({ multiagent: { ...ALL_OFF, subagents: { enabled: true, inlineAgents: false, savedAgents: [{ id: 'agent_new', version: null }] } } })
  expect(summary(formChanges(added, form))).toEqual([
    { path: 'Multiagent', before: null, after: 'subagents' },
    { path: 'Subagents saved agent', before: null, after: 'agent_new' }
  ])
})

test('AC-5: the review names each saved agent added or removed from a member that stays on, and leaves an untouched member alone', () => {
  const changed = withSaved('subagents', [{ id: 'agent_b', version: 1 }, { id: 'agent_new', version: null }])
  expect(summary(formChanges(changed, twoForm))).toEqual([
    { path: 'Subagents saved agent', before: null, after: 'agent_new' },
    { path: 'Subagents saved agent', before: 'agent_a', after: null }
  ])
  // Une liste inchangée ne produit aucune ligne.
  expect(formChanges(twoForm, twoForm)).toEqual([])
})

test('the staged review shows saved agents by name, This agent for the edited agent, and the id when the agent is unknown', async () => {
  const { api, prepare } = setup()
  api.agents.set('agent_writer', { ...structuredClone(fixture), id: 'agent_writer', name: 'Writer' } as unknown as AgentRecord)
  const saved = [{ id: 'agent_writer', version: null }, { id: 'agent_1', version: null }, { id: 'agent_gone', version: null }]
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: withSaved('subagents', saved), base: twoForm })
  expect(prepared.ok && prepared.value.changes.filter((change) => change.path === 'Subagents saved agent' && change.before === null).map((change) => change.after)).toEqual([
    'Writer',
    'This agent',
    'agent_gone'
  ])
})

test('a member turned off reports the saved agents it loses on its state line, not one line per agent', () => {
  const off = { ...twoForm, multiagent: { ...twoForm.multiagent!, subagents: ALL_OFF.subagents } }
  expect(summary(formChanges(off, twoForm))).toEqual([{ path: 'Subagents', before: 'enabled', after: 'disabled (removes 2 saved agents)' }])
})

test('prepareAgentForm refuses an advisor without a model and an enabled member with neither inline nor predefined agents', async () => {
  const { api, prepare } = setup()
  expect(await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ multiagent: { ...ALL_OFF, advisor: '' } }), base: form })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'advisor model is required.'
  })
  const noInline = { enabled: true, inlineAgents: false, savedAgents: [] }
  expect(await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ multiagent: { ...ALL_OFF, subagents: noInline } }), base: form })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Subagents need inline agents or at least one saved agent.'
  })
  expect(await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ multiagent: { ...ALL_OFF, workflows: noInline } }), base: form })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Workflows need inline agents or at least one saved agent.'
  })
  // Avec des agents enregistrés, inline éteint est permis.
  const allowed = await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ multiagent: { ...ALL_OFF, subagents: { ...noInline, savedAgents: [{ id: 'agent_helper', version: null }] } } }), base: form })
  expect(allowed.ok).toBe(true)
  expect(api.calls.filter((call) => call.method === 'agents.update').length).toBe(0)
})

test('a form kept from before the multiagent field (no key) changes nothing and reviews nothing for the block', () => {
  const legacy = { ...form } as Partial<AgentForm>
  delete legacy.multiagent
  const after = applyAgentForm(doc, legacy as AgentForm, legacy as AgentForm)
  expect(diffDocuments(doc, after)).toEqual([])
  expect(formChanges(legacy as AgentForm, legacy as AgentForm)).toEqual([])
})

test('the multiagent review reads as one line when the block is added or removed, and one per member when it changes', () => {
  const added = withForm({ multiagent: { ...ALL_OFF, advisor: 'claude-fable-5-2', subagents: { enabled: true, inlineAgents: true, savedAgents: [] } } })
  expect(summary(formChanges(added, form))).toEqual([{ path: 'Multiagent', before: null, after: 'advisor claude-fable-5-2, subagents' }])
  expect(summary(formChanges(withForm({ multiagent: null }), blockForm))).toEqual([
    { path: 'Multiagent (removes 1 saved agent)', before: 'advisor claude-fable-5-2, subagents', after: null }
  ])
  const changed = { ...blockForm, multiagent: { advisor: null, subagents: { ...blockForm.multiagent!.subagents, inlineAgents: true }, workflows: { enabled: true, inlineAgents: false, savedAgents: [] } } }
  expect(summary(formChanges(changed, blockForm))).toEqual([
    { path: 'Advisor', before: 'claude-fable-5-2', after: 'disabled' },
    { path: 'Subagents', before: 'enabled, no inline agents', after: 'enabled' },
    { path: 'Workflows', before: 'disabled', after: 'enabled, no inline agents' }
  ])
})

test('turning a member with saved agents off says how many the review removes', () => {
  const off = { ...blockForm, multiagent: { ...blockForm.multiagent!, subagents: ALL_OFF.subagents } }
  expect(summary(formChanges(off, blockForm))).toEqual([{ path: 'Subagents', before: 'enabled, no inline agents', after: 'disabled (removes 1 saved agent)' }])
})

test('an untouched multiagent form leaves a block changed elsewhere as it is, even on another change', () => {
  const live = agentToDocument(withBlock({ type: 'coordinator', agents: [{ type: 'self' }] }))
  const after = applyAgentForm(live, { ...blockForm, name: 'Renamed' }, blockForm)
  expect(after.multiagent).toEqual(live.multiagent)
  expect(diffDocuments(live, after).map((change) => change.path)).toEqual(['name'])
})

test('a staged multiagent change sends the multiagent key only, and clearing it sends null', async () => {
  const { api, pending, prepare } = setup()
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: withForm({ multiagent: { ...ALL_OFF, subagents: { enabled: true, inlineAgents: true, savedAgents: [] } } }), base: form })
  expect(prepared.ok && prepared.value.changes.map((change) => change.path)).toEqual(['Multiagent'])
  expect(await commitOf(pending, prepared, false)).toEqual({ ok: true, value: { label: 'Applied, v6', id: 'agent_1' } })
  const sent = only(api.calls, 'agents.update')[0]?.args[1] as Record<string, unknown>
  expect(Object.keys(sent).sort()).toEqual(['multiagent', 'version'])
  // L'agent a maintenant un bloc : le retirer envoie `null`.
  const stored = toAgentForm(api.agents.get('agent_1') as unknown as BetaManagedAgentsAgent)
  const cleared = await prepare({ agentId: 'agent_1', baseVersion: 6, form: { ...stored, multiagent: null }, base: stored })
  await commitOf(pending, cleared, false)
  expect((only(api.calls, 'agents.update')[1]?.args[1] as Record<string, unknown>).multiagent).toBe(null)
})

// --- Skills ---

const SKILL_PINS = [
  { type: 'custom', skill_id: 'skill_triage', version: '3' },
  { type: 'anthropic', skill_id: 'xlsx', version: 'latest' }
]
const skilledAgent = { ...structuredClone(fixture), skills: SKILL_PINS } as unknown as BetaManagedAgentsAgent
const skilledForm = toAgentForm(skilledAgent)
const skilledDoc = agentToDocument(skilledAgent)

const withSkills = (skills: AgentForm['skills'], from: AgentForm = skilledForm): AgentForm => ({ ...from, skills })

test('the skills of the response map to the form with their pinned versions, and an agent without skills has an empty list', () => {
  expect(form.skills).toEqual([])
  expect(skilledForm.skills).toEqual([
    { type: 'custom', skillId: 'skill_triage', version: '3' },
    { type: 'anthropic', skillId: 'xlsx', version: 'latest' }
  ])
})

test('an unchanged form, or a change to another field, leaves the skills of the document alone, pins included', () => {
  expect(diffDocuments(skilledDoc, applyAgentForm(skilledDoc, skilledForm, skilledForm))).toEqual([])
  const renamed = applyAgentForm(skilledDoc, { ...skilledForm, name: 'Renamed' }, skilledForm)
  expect(renamed.skills).toEqual(SKILL_PINS)
  expect(diffDocuments(skilledDoc, renamed).map((change) => change.path)).toEqual(['name'])
})

test('an added skill is written without a version, and the skills already there keep their entry and pin', () => {
  const added = withSkills([...skilledForm.skills, { type: 'custom', skillId: 'skill_new', version: null }])
  expect(applyAgentForm(skilledDoc, added, skilledForm).skills).toEqual([...SKILL_PINS, { type: 'custom', skill_id: 'skill_new' }])
  // Un agent sans skill : la clé naît avec le seul ajout.
  expect(applyAgentForm(doc, withSkills([{ type: 'anthropic', skillId: 'pdf', version: null }], form), form).skills).toEqual([{ type: 'anthropic', skill_id: 'pdf' }])
})

test('a removed skill leaves only that entry, and removing the last one writes an empty list', () => {
  const one = applyAgentForm(skilledDoc, withSkills([skilledForm.skills[1]!]), skilledForm)
  expect(one.skills).toEqual([SKILL_PINS[1]])
  expect(applyAgentForm(skilledDoc, withSkills([]), skilledForm).skills).toEqual([])
})

test('a skill pinned elsewhere since the form opened keeps the live pin, and one added elsewhere survives', () => {
  const live = { ...skilledDoc, skills: [{ type: 'custom', skill_id: 'skill_triage', version: '4' }, SKILL_PINS[1], { type: 'custom', skill_id: 'skill_other', version: '1' }] }
  const after = applyAgentForm(live, withSkills([skilledForm.skills[0]!, { type: 'custom', skillId: 'skill_new', version: null }]), skilledForm)
  expect(after.skills).toEqual([
    { type: 'custom', skill_id: 'skill_triage', version: '4' },
    { type: 'custom', skill_id: 'skill_other', version: '1' },
    { type: 'custom', skill_id: 'skill_new' }
  ])
})

test('a creation writes the skills of the form and nothing when it has none', () => {
  expect(applyAgentForm({}, withSkills([{ type: 'anthropic', skillId: 'xlsx', version: null }], form), null).skills).toEqual([{ type: 'anthropic', skill_id: 'xlsx' }])
  expect('skills' in applyAgentForm({}, form, null)).toBe(false)
})

test('the review has one Skill line per skill added or removed, and none for an untouched list', () => {
  const changed = withSkills([skilledForm.skills[1]!, { type: 'custom', skillId: 'skill_new', version: null }])
  expect(summary(formChanges(changed, skilledForm))).toEqual([
    { path: 'Skill', before: null, after: 'skill_new' },
    { path: 'Skill', before: 'skill_triage', after: null }
  ])
  expect(formChanges(skilledForm, skilledForm)).toEqual([])
  expect(summary(formChanges(withSkills([{ type: 'anthropic', skillId: 'pdf', version: null }], form), null)).filter((line) => line.path === 'Skill')).toEqual([
    { path: 'Skill', before: null, after: 'pdf' }
  ])
})

/** Un faux client dont les listes de skills rendent ce qu'on lui donne ; une source absente de `sources` échoue. */
function withSkillLists(api: ReturnType<typeof fakeApi>, sources: Partial<Record<string, { id: string; display_name: string }[]>>): void {
  const original = api.store.get
  api.store.get = async () =>
    ({
      ...(await original()),
      skills: {
        list: async function* ({ source }: { source: string }) {
          const rows = sources[source]
          if (rows === undefined) throw new Error('skills unavailable')
          yield* rows
        }
      }
    }) as never
}

test('the staged review names the skills, from the workspace and from Anthropic', async () => {
  const { api, prepare } = setup()
  api.agents.set('agent_1', { ...structuredClone(skilledAgent), id: 'agent_1' } as unknown as AgentRecord)
  withSkillLists(api, {
    custom: [{ id: 'skill_triage', display_name: 'incident-triage' }, { id: 'skill_new', display_name: 'vulgarise' }],
    anthropic: [{ id: 'pdf', display_name: 'pdf' }, { id: 'xlsx', display_name: 'xlsx' }]
  })
  const changed = withSkills([skilledForm.skills[1]!, { type: 'custom', skillId: 'skill_new', version: null }, { type: 'anthropic', skillId: 'pdf', version: null }])
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: changed, base: skilledForm })
  expect(prepared.ok && summary(prepared.value.changes)).toEqual([
    { path: 'Skill', before: null, after: 'vulgarise' },
    { path: 'Skill', before: null, after: 'pdf' },
    { path: 'Skill', before: 'incident-triage', after: null }
  ])
})

test('when a skills list cannot be read, the review keeps the ids of that source and names the other', async () => {
  const { api, prepare } = setup()
  api.agents.set('agent_1', { ...structuredClone(skilledAgent), id: 'agent_1' } as unknown as AgentRecord)
  withSkillLists(api, { custom: [{ id: 'skill_new', display_name: 'vulgarise' }] })
  const changed = withSkills([...skilledForm.skills, { type: 'custom', skillId: 'skill_new', version: null }, { type: 'anthropic', skillId: 'pdf', version: null }])
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: changed, base: skilledForm })
  expect(prepared.ok && summary(prepared.value.changes)).toEqual([
    { path: 'Skill', before: null, after: 'vulgarise' },
    { path: 'Skill', before: null, after: 'pdf' }
  ])
})

test('a staged skills change sends the skills key only, with the kept pins and the added skill without a version', async () => {
  const { api, pending, prepare } = setup()
  api.agents.set('agent_1', { ...structuredClone(skilledAgent), id: 'agent_1' } as unknown as AgentRecord)
  const changed = withSkills([...skilledForm.skills, { type: 'anthropic', skillId: 'pdf', version: null }])
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 5, form: changed, base: skilledForm })
  expect(await commitOf(pending, prepared, false)).toEqual({ ok: true, value: { label: 'Applied, v6', id: 'agent_1' } })
  const sent = only(api.calls, 'agents.update')[0]?.args[1] as Record<string, unknown>
  expect(Object.keys(sent).sort()).toEqual(['skills', 'version'])
  expect(sent.skills).toEqual([...SKILL_PINS, { type: 'anthropic', skill_id: 'pdf' }])
})
