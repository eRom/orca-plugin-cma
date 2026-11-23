import Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { BUILTIN_TOOLS, type AgentForm, type ApiResult, type Committed, type PreparedWrite } from '../protocol'
import { agentToDocument, type AgentDocument } from './agent-yaml'
import { agentFormOptions, applyAgentForm, prepareAgentForm, toAgentForm } from './agent-form'
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
  const cleared = applyAgentForm(doc, withForm({ effort: null }), form)
  expect(cleared.model).toEqual({ id: 'claude-haiku-5-5', speed: 'standard' })
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
  const bare = applyAgentForm({}, { name: 'x', model: 'claude-haiku-5-5', effort: null, description: 'd', builtinTools: null, mcpServers: [] }, null)
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
  const logs: string[] = []
  const prepare = (input: Parameters<typeof prepareAgentForm>[3]): Promise<ApiResult<PreparedWrite>> =>
    prepareAgentForm(api.store, pending, (message) => logs.push(message), input)
  return { api, pending, logs, prepare }
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
  expect(prepared.ok && prepared.value.changes.map((change) => change.path)).toEqual(['tools[0].default_config.permission_policy.type'])
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

test('when the opened version cannot be read back, the live version stands in for it and the log says so', async () => {
  const { api, logs, prepare } = setup()
  await api.elsewhere({ description: 'Changed in the console.' })
  api.agents.get('agent_1')!.version = 6
  const prepared = await prepare({ agentId: 'agent_1', baseVersion: 3, form: POLICY_CHANGE, base: form })
  expect(prepared.ok).toBe(true)
  expect(logs.some((message) => message.includes('agent_1 v3 could not be read back'))).toBe(true)
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
