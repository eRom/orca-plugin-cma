import { read } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import type { AgentDetail, AgentForm, ConfigKind, ConfigRow, DraftInfo, DraftRef, PreparedWrite } from '../protocol'
import { BUILTIN_TOOLS } from '../protocol'
import * as panel from '../panel'
import { leaveAgentView, withoutTransientFlows } from './agent-form'
import { formDrafts } from './form-state'

const WITH_KEY = { hasKey: true, keyRejected: false, workspaceId: 'wrkspc_x', organizationName: 'Check Org' }
const FOLDER = '/Users/someone/.config/agent-claude-managed/managed-agents'

const FORM: AgentForm = {
  name: 'Incident commander',
  model: 'claude-haiku-5-5',
  effort: 'high',
  description: 'Triages incidents.',
  builtinTools: {
    enabled: true,
    policy: 'always_allow',
    tools: BUILTIN_TOOLS.map((name) => ({ name, enabled: name === 'web_search' ? false : null, policy: null }))
  },
  mcpServers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', policy: 'always_ask' }]
}

const DETAIL: AgentDetail = {
  kind: 'agent',
  id: 'agent_a',
  name: 'Incident commander',
  version: 5,
  form: FORM,
  model: 'claude-haiku-5-5',
  effort: 'high',
  description: 'Triages incidents.',
  system: { text: 'You are an incident commander.', truncated: false },
  builtinTools: { enabled: true, policy: 'always_allow', overrides: [{ name: 'web_search', enabled: false, policy: null }] },
  mcpServers: [
    {
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      enabled: true,
      policy: 'always_ask',
      overrides: [{ name: 'list_commits', enabled: true, policy: 'always_allow' }]
    }
  ],
  skills: ['skill_triage'],
  multiagent: 'Multiagent: advisor claude-opus-5'
}

const NEW_DETAIL: AgentDetail = {
  ...DETAIL,
  id: 'agent_new',
  name: 'plugin-test-agent',
  version: 1,
  form: { ...FORM, name: 'plugin-test-agent', mcpServers: [] }
}

const ROWS: ConfigRow[] = [{ kind: 'agent', id: 'agent_a', name: 'Incident commander', summary: 'v5 · claude-haiku-5-5' }]

const PREPARED: PreparedWrite = {
  token: 'plugin-test-token-QUOKKA-xyz',
  changes: [{ path: 'model.effort', before: 'high', after: null, lines: null }],
  totalChanges: 1,
  creates: false
}

const INFO: DraftInfo = {
  ref: { kind: 'agent', agentId: null },
  file: 'new-agent.yaml',
  unapplied: false,
  writtenAt: '2026-11-22T10:00:00Z',
  savedAt: '2026-11-22T10:00:00Z',
  returnTo: { workspaceId: 'ws_orca', name: 'orca' }
}

const OPEN_DETAIL = { plugin: { nav: [{ view: 'home' }, { view: 'config', kind: 'agent', id: 'agent_a' }] } }
const OPEN_NEW = { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'agent' }] } }

type PrepareInput = { agentId: string | null; baseVersion: number | null; form: AgentForm; base: AgentForm | null }

/** Ce que le faux worker a reçu, dans l'ordre. */
type Calls = {
  prepares: PrepareInput[]
  commits: { token: string; force: boolean }[]
  details: string[]
  lists: ConfigKind[]
  archives: unknown[]
  opens: DraftRef[]
  yamlPrepares: DraftRef[]
}

function newCalls(): Calls {
  return { prepares: [], commits: [], details: [], lists: [], archives: [], opens: [], yamlPrepares: [] }
}

function requests(calls: Calls, over: Record<string, unknown> = {}) {
  return {
    'workspace.info': WITH_KEY,
    'sessions.visibility': { bootId: 'boot-1', watching: null },
    'sessions.list': { ok: true, value: [] },
    'configs.list': ({ kind }: { kind: ConfigKind }) => {
      calls.lists.push(kind)
      return { ok: true, value: kind === 'agent' ? ROWS : [] }
    },
    'configs.detail': ({ id }: { id: string }) => {
      calls.details.push(id)
      return { ok: true, value: id === 'agent_new' ? NEW_DETAIL : DETAIL }
    },
    'agent.formOptions': { ok: true, value: { models: ['claude-sonnet-5', 'claude-opus-5'] } },
    'agent.prepareForm': (input: PrepareInput) => {
      calls.prepares.push(input)
      return { ok: true, value: PREPARED }
    },
    'write.commit': (input: { token: string; force: boolean }) => {
      calls.commits.push(input)
      return { ok: true, value: { label: 'Applied, v6', id: 'agent_a' } }
    },
    'resource.archive': (input: unknown) => {
      calls.archives.push(input)
      return { ok: true, value: null }
    },
    'drafts.status': { folder: FOLDER, ready: true },
    'draft.state': { ok: true, value: null },
    'draft.open': (input: DraftRef) => {
      calls.opens.push(input)
      return { ok: true, value: INFO }
    },
    'draft.prepare': (input: DraftRef) => {
      calls.yamlPrepares.push(input)
      return { ok: true, value: { ...PREPARED, creates: true } }
    },
    ...over
  } as never
}

type View = Awaited<ReturnType<typeof mount>>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const button = (view: View, text: string) => view.find({ role: 'button', text })

/** Ouvre la section repliée des réglages par outil. */
async function openPerTool(view: View): Promise<void> {
  await view.toggle({ type: 'Collapsible', text: /Per-tool settings/ })
}

function optionValues(view: View, label: string): string[] {
  const options = view.find({ type: 'Select', label })?.props.options
  assert.ok(Array.isArray(options))
  return (options as { value: string }[]).map((option) => option.value)
}

// --- Modèle, effort ---

test('offers the models of agent.formOptions plus the current model when it is missing', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  assert.deepEqual(optionValues(view, 'Model'), ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5'])
  assert.equal(view.valueOf({ label: 'Model' }), 'claude-haiku-5-5')
  await view.select({ label: 'Model' }, 'claude-opus-5')
  await view.press({ role: 'button', text: 'Review changes' })
  assert.equal(calls.prepares[0]?.form.model, 'claude-opus-5')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('falls back to a text field for the model when the API lists none', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, { 'agent.formOptions': { ok: true, value: { models: [] } } }) })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  assert.equal(view.find({ type: 'Select', label: 'Model' }), null)
  assert.equal(view.valueOf({ label: 'Model' }), 'claude-haiku-5-5')
  await view.type({ label: 'Model' }, 'claude-sonnet-5', { replace: true })
  await view.press({ role: 'button', text: 'Review changes' })
  assert.equal(calls.prepares[0]?.form.model, 'claude-sonnet-5')
  await view.unmount()
})

test('an existing agent offers the five efforts and no Default: omitting the effort keeps the stored one', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  assert.deepEqual(optionValues(view, 'Effort'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(view.valueOf({ label: 'Effort' }), 'high')
  await view.select({ label: 'Effort' }, 'low')
  await view.press({ role: 'button', text: 'Review changes' })
  assert.equal(calls.prepares[0]?.form.effort, 'low')
  await view.unmount()
})

test('a new agent offers Default for the effort, which sends null', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_NEW })
  assert.deepEqual(optionValues(view, 'Effort'), ['default', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(view.valueOf({ label: 'Effort' }), 'default')
  await view.type({ label: 'Name' }, 'plugin-test-agent')
  await view.select({ label: 'Model' }, 'claude-sonnet-5')
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.prepares[0]?.form.effort, null)
  await view.unmount()
})

test('a new agent starts with the auto permission, like the console and the YAML template', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_NEW })
  assert.equal(view.valueOf({ label: 'Default permission' }), 'auto')
  await view.type({ label: 'Name' }, 'plugin-test-agent')
  await view.select({ label: 'Model' }, 'claude-sonnet-5')
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.prepares[0]?.form.builtinTools?.policy, 'auto')
  await view.unmount()
})

// --- Outils intégrés ---

test('built-in tools: the switch and the default permission stay visible, the per-tool rows are folded with a summary', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  assert.equal(view.valueOf({ label: 'Enabled' }), true)
  assert.equal(view.valueOf({ label: 'Default permission' }), 'always_allow')
  assert.deepEqual(optionValues(view, 'Default permission'), ['always_allow', 'always_ask', 'auto'])
  // Fermé par défaut : aucune ligne d'outil, un résumé d'une ligne.
  assert.equal(view.find({ label: 'bash state' }), null)
  const collapsible = view.find({ type: 'Collapsible', text: /Per-tool settings/ })
  assert.ok(collapsible)
  assert.equal(collapsible.props.open, false)
  assert.ok(String(collapsible.props.description).includes('1 tool customised'))
  await openPerTool(view)
  for (const name of BUILTIN_TOOLS) {
    assert.deepEqual(optionValues(view, `${name} state`), ['default', 'enabled', 'disabled'])
    assert.deepEqual(optionValues(view, `${name} permission`), ['default', 'always_allow', 'always_ask', 'auto'])
  }
  assert.equal(view.valueOf({ label: 'web_search state' }), 'disabled')
  assert.equal(view.valueOf({ label: 'bash state' }), 'default')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the built-in tools zone is a titled group like the MCP servers zone, with the switch labelled Enabled', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  // Même bloc, donc même titre (semibold) et même surface que la zone des serveurs MCP.
  assert.equal(view.find({ type: 'Text', text: 'Built-in tools' })?.props.weight, 'semibold')
  assert.equal(view.find({ type: 'Text', text: 'MCP servers' })?.props.weight, 'semibold')
  // Le titre n'est plus répété par l'interrupteur.
  assert.equal(view.findAll({ text: 'Built-in tools' }).length, 1)
  assert.ok(view.find({ label: 'Enabled' }))
  await view.unmount()
})

test('per-tool selects send null for Default and the chosen value otherwise', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  await openPerTool(view)
  await view.select({ label: 'bash state' }, 'enabled')
  await view.select({ label: 'bash permission' }, 'always_ask')
  await view.select({ label: 'web_search state' }, 'default')
  await view.select({ label: 'Default permission' }, 'auto')
  await view.toggle({ label: 'Enabled' })
  await view.press({ role: 'button', text: 'Review changes' })
  const tools = calls.prepares[0]?.form.builtinTools
  assert.ok(tools)
  assert.equal(tools.enabled, false)
  assert.equal(tools.policy, 'auto')
  assert.deepEqual(tools.tools.find((tool) => tool.name === 'bash'), { name: 'bash', enabled: true, policy: 'always_ask' })
  assert.deepEqual(tools.tools.find((tool) => tool.name === 'web_search'), { name: 'web_search', enabled: null, policy: null })
  await view.unmount()
})

// --- Serveurs MCP ---

test('an MCP server row shows its name, its URL, its policy and a Remove action', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  const row = view.find({ text: /github/, type: 'Box' })
  assert.ok(row)
  assert.ok(view.find({ text: 'https://api.githubcopilot.com/mcp/' }))
  assert.equal(view.valueOf({ label: 'Policy of github' }), 'always_ask')
  // Le Select est l'unique contrôle de la politique : aucune pastille de statut ne la répète.
  assert.equal(view.findAll({ type: 'Badge' }).length, 0)
  await view.select({ label: 'Policy of github' }, 'always_allow')
  assert.equal(view.valueOf({ label: 'Policy of github' }), 'always_allow')
  await view.press({ role: 'button', label: 'Remove github' })
  assert.equal(view.find({ label: 'Policy of github' }), null)
  await view.press({ role: 'button', text: 'Review changes' })
  assert.deepEqual(calls.prepares[0]?.form.mcpServers, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Add MCP server opens a compact form, closed by default, and appends the server with always_ask', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  // Fermé : seuls Name et URL de l'agent n'existent pas, le formulaire d'ajout non plus.
  assert.equal(view.find({ label: 'URL' }), null)
  assert.equal(view.findAll({ label: 'Name' }).length, 1)
  await view.press({ role: 'button', text: 'Add MCP server' })
  assert.equal(view.find({ role: 'button', text: 'Add MCP server' }), null)
  assert.ok(view.find({ label: 'URL' }))
  assert.equal(button(view, 'Add')?.disabled, true)
  const name = view.findAll({ label: 'Name' })[1]
  assert.ok(name)
  // Aucune erreur avant que le champ soit touché.
  assert.equal(view.find({ text: 'Use an http or https URL.' }), null)
  await view.type(name, 'linear')
  await view.type({ label: 'URL' }, 'not a url')
  assert.ok(view.find({ text: 'Use an http or https URL.' }))
  assert.equal(button(view, 'Add')?.disabled, true)
  await view.type({ label: 'URL' }, 'https://mcp.linear.app/mcp', { replace: true })
  assert.equal(button(view, 'Add')?.disabled, false)
  await view.press({ role: 'button', text: 'Add' })
  assert.equal(view.find({ label: 'URL' }), null)
  assert.equal(view.valueOf({ label: 'Policy of linear' }), 'always_ask')
  await view.press({ role: 'button', text: 'Review changes' })
  assert.deepEqual(calls.prepares[0]?.form.mcpServers, [
    { name: 'github', url: 'https://api.githubcopilot.com/mcp/', policy: 'always_ask' },
    { name: 'linear', url: 'https://mcp.linear.app/mcp', policy: 'always_ask' }
  ])
  await view.unmount()
})

test('refuses an MCP server whose name is already used', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: OPEN_DETAIL })
  await view.press({ role: 'button', text: 'Add MCP server' })
  await view.type(view.findAll({ label: 'Name' })[1] ?? { label: 'Name' }, 'github')
  await view.type({ label: 'URL' }, 'https://example.com/mcp')
  assert.ok(view.find({ text: 'A server with this name already exists.' }))
  assert.equal(button(view, 'Add')?.disabled, true)
  await view.unmount()
})

// --- Revue ---

test('Review changes is disabled until something changed, then previews and applies the write', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  assert.equal(button(view, 'Review changes')?.disabled, true)
  // L'action principale se lit comme telle : pleine, ton d'accent.
  assert.equal(button(view, 'Review changes')?.props.variant, 'solid')
  assert.equal(button(view, 'Review changes')?.props.tone, 'accent')
  await view.type({ label: 'Description' }, ' More.')
  assert.equal(button(view, 'Review changes')?.disabled, false)
  assert.ok(view.find({ text: 'Unsaved changes' }))
  await view.press({ role: 'button', text: 'Review changes' })
  assert.equal(calls.prepares.length, 1)
  const sent = calls.prepares[0]
  assert.ok(sent)
  assert.equal(sent.agentId, 'agent_a')
  assert.equal(sent.baseVersion, 5)
  assert.deepEqual(sent.base, FORM)
  assert.equal(sent.form.description, 'Triages incidents. More.')
  // L'aperçu : la liste des changements, puis Confirm ; le formulaire est figé.
  assert.ok(view.find({ type: 'List', label: 'Changes' }))
  assert.equal(view.find({ role: 'button', text: 'Review changes' }), null)
  assert.equal(view.find({ label: 'Description' })?.disabled, true)
  assert.equal(calls.commits.length, 0)
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Confirm' })
  assert.deepEqual(calls.commits, [{ token: PREPARED.token, force: false }])
  assert.ok(view.find({ text: 'Applied, v6' }))
  // La liste et le détail sont relus, la saisie gardée disparaît.
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['agent_a', 'agent_a'])
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Cancel on the preview returns to the form with the edits kept', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, ' More.')
  await view.press({ role: 'button', text: 'Review changes' })
  await view.press({ role: 'button', text: 'Cancel' })
  assert.equal(calls.commits.length, 0)
  assert.equal(view.valueOf({ label: 'Description' }), 'Triages incidents. More.')
  assert.equal(view.find({ label: 'Description' })?.disabled, false)
  assert.equal(button(view, 'Review changes')?.disabled, false)
  await view.unmount()
})

test('a kept draft opened on an earlier version is sent with its own baseVersion and base', async () => {
  const calls = newCalls()
  const olderBase: AgentForm = { ...FORM, description: 'Older description.' }
  const kept: AgentForm = { ...olderBase, description: 'Older description, edited.' }
  const persisted = {
    plugin: { ...OPEN_DETAIL.plugin, 'forms.drafts': { 'agent:agent_a': { form: kept, base: olderBase, baseStamp: 3 } } }
  }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.equal(view.valueOf({ label: 'Description' }), 'Older description, edited.')
  assert.ok(view.find({ text: /Started on v3, the agent is now v5/ }))
  await view.press({ role: 'button', text: 'Review changes' })
  const sent = calls.prepares[0]
  assert.ok(sent)
  assert.equal(sent.baseVersion, 3)
  assert.deepEqual(sent.base, olderBase)
  assert.deepEqual(sent.form, kept)
  await view.unmount()
})

test('a conflict offers Reload and Apply anyway, and Apply anyway forces the write', async () => {
  const calls = newCalls()
  let answers = 0
  const host = mockHost({
    requests: requests(calls, {
      'write.commit': (input: { token: string; force: boolean }) => {
        calls.commits.push(input)
        answers += 1
        return answers === 1
          ? { ok: false, code: 'conflict', error: 'Changed elsewhere: v5 → v6.' }
          : { ok: true, value: { label: 'Applied, v7', id: 'agent_a' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, ' More.')
  await view.press({ role: 'button', text: 'Review changes' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere: v5 → v6\./ }))
  assert.ok(button(view, 'Reload'))
  await view.press({ role: 'button', text: 'Apply anyway' })
  assert.deepEqual(calls.commits.map((commit) => commit.force), [false, true])
  assert.ok(view.find({ text: 'Applied, v7' }))
  await view.unmount()
})

test('Reload after a conflict drops the kept edits and reads the agent again', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, { 'write.commit': { ok: false, code: 'conflict', error: 'Changed elsewhere: v5 → v6.' } })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, ' More.')
  await view.press({ role: 'button', text: 'Review changes' })
  await view.press({ role: 'button', text: 'Confirm' })
  await view.press({ role: 'button', text: 'Reload' })
  assert.deepEqual(calls.details, ['agent_a', 'agent_a'])
  assert.equal(view.valueOf({ label: 'Description' }), 'Triages incidents.')
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a kept input identical to its base but opened on an earlier version still offers Reload, which drops it', async () => {
  const calls = newCalls()
  const persisted = {
    plugin: { ...OPEN_DETAIL.plugin, 'forms.drafts': { 'agent:agent_a': { form: FORM, base: FORM, baseStamp: 3 } } }
  }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  // Rien n'a été modifié : pas de « Discard », et le texte ne promet que la sortie qui existe.
  assert.equal(view.find({ role: 'button', text: 'Discard' }), null)
  assert.equal(view.find({ text: /Discard drops them/ }), null)
  const reload = button(view, 'Reload')
  assert.ok(reload)
  assert.equal(reload.props.variant, 'outline')
  await view.press({ role: 'button', text: 'Reload' })
  assert.deepEqual(calls.details, ['agent_a', 'agent_a'])
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a stale kept input with edits offers Reload and Discard, and both drop it', async () => {
  const calls = newCalls()
  const kept: AgentForm = { ...FORM, description: 'Mine' }
  const persisted = {
    plugin: { ...OPEN_DETAIL.plugin, 'forms.drafts': { 'agent:agent_a': { form: kept, base: FORM, baseStamp: 3 } } }
  }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.ok(button(view, 'Reload'))
  assert.ok(button(view, 'Discard'))
  await view.press({ role: 'button', text: 'Reload' })
  assert.equal(view.valueOf({ label: 'Description' }), 'Triages incidents.')
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a refusal to prepare shows its notice and keeps the form', async () => {
  const host = mockHost({
    requests: requests(newCalls(), {
      'agent.prepareForm': { ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: you have not changed anything.' }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, '!')
  await view.press({ role: 'button', text: 'Review changes' })
  assert.ok(view.find({ type: 'Callout', text: /Nothing to apply/ }))
  assert.equal(view.valueOf({ label: 'Description' }), 'Triages incidents.!')
  await view.unmount()
})

// --- Résumés en lecture seule et YAML ---

test('keeps the read-only summaries and one Edit in YAML link that opens the agent draft', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  assert.equal(view.find({ type: 'CodeView' })?.props.code, 'You are an incident commander.')
  assert.ok(view.find({ text: /skill_triage/ }))
  assert.ok(view.find({ text: /advisor claude-opus-5/ }))
  assert.ok(view.find({ type: 'KeyValue', label: 'github tool settings' })?.text.includes('list_commits'))
  const links = view.findAll({ role: 'button', text: 'Edit in YAML' })
  assert.equal(links.length, 1)
  assert.equal(links[0]?.props.variant, 'outline')
  assert.equal(links[0]?.props.size, 'sm')
  await view.press({ role: 'button', text: 'Edit in YAML' })
  assert.deepEqual(calls.opens, [{ kind: 'agent', agentId: 'agent_a' }])
  // Une seule carte de brouillon : le brouillon ouvert propose Apply une fois.
  assert.equal(view.findAll({ role: 'button', text: 'Apply' }).length, 1)
  await view.unmount()
})

// --- Archivage ---

test('Archive asks first with the question, archives on Confirm, and there is no Delete', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  assert.equal(view.find({ role: 'button', text: 'Delete' }), null)
  await view.press({ role: 'button', text: 'Archive' })
  assert.ok(view.find({ type: 'Callout', text: /Archive Incident commander\? This can't be undone\./ }))
  assert.deepEqual(calls.archives, [])
  await view.press({ role: 'button', text: 'Cancel' })
  assert.deepEqual(calls.archives, [])
  assert.equal(view.find({ type: 'Callout', text: /Archive Incident commander\?/ }), null)
  await view.unmount()
})

test('Archive then Confirm archives the agent and returns to the list', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  await view.press({ role: 'button', text: 'Archive' })
  const confirms = view.findAll({ role: 'button', text: 'Archive' })
  // Le bouton de la ligne du bas et celui de l'encart : l'encart est le dernier.
  const confirm = confirms[confirms.length - 1]
  assert.ok(confirm)
  await view.press(confirm)
  assert.deepEqual(calls.archives, [{ kind: 'agent', id: 'agent_a' }])
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

// --- Nouvel agent ---

test('New agent on the home tab opens the empty form, Create is the single solid action', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }) })
  await view.press({ role: 'button', text: 'New agent' })
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'newConfig', kind: 'agent' }])
  assert.equal(view.valueOf({ label: 'Name' }), '')
  assert.equal(button(view, 'Create')?.disabled, true)
  // Une seule action pleine dans tout l'écran.
  const solid = view.findAll({ role: 'button' }).filter((entry) => entry.props.variant === undefined || entry.props.variant === 'solid')
  assert.deepEqual(solid.map((entry) => entry.text), ['Create'])
  assert.equal(button(view, 'Create')?.props.tone, 'accent')
  // Create grisé parce que le nom et le modèle manquent : l'avis en sourdine le dit.
  assert.ok(view.find({ text: 'Name and model are required.' }))
  // Pas d'erreur avant d'avoir touché le nom.
  assert.notEqual(view.find({ type: 'Input', label: 'Name' })?.props.invalid, true)
  await view.type({ label: 'Name' }, 'x')
  await view.type({ label: 'Name' }, '', { replace: true })
  assert.equal(view.find({ type: 'Input', label: 'Name' })?.props.invalid, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Create sends the form with no base, then opens the new agent from Committed.id', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'write.commit': (input: { token: string; force: boolean }) => {
        calls.commits.push(input)
        return { ok: true, value: { label: 'Applied, v1', id: 'agent_new' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  await view.type({ label: 'Name' }, 'plugin-test-agent')
  assert.equal(button(view, 'Create')?.disabled, true)
  await view.select({ label: 'Model' }, 'claude-sonnet-5')
  await view.select({ label: 'Effort' }, 'low')
  assert.equal(button(view, 'Create')?.disabled, false)
  assert.equal(view.find({ text: 'Name and model are required.' }), null)
  await view.press({ role: 'button', text: 'Create' })
  const sent = calls.prepares[0]
  assert.ok(sent)
  assert.equal(sent.agentId, null)
  assert.equal(sent.baseVersion, null)
  assert.equal(sent.base, null)
  assert.equal(sent.form.name, 'plugin-test-agent')
  assert.equal(sent.form.model, 'claude-sonnet-5')
  assert.equal(sent.form.effort, 'low')
  assert.equal(calls.commits.length, 1)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'agent', id: 'agent_new' }])
  assert.deepEqual(calls.details, ['agent_new'])
  assert.ok(view.find({ text: 'Applied, v1' }))
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Create goes straight to the write: the button is busy and no changes preview ever shows', async () => {
  const calls = newCalls()
  const seen: { creating: boolean; creatingDisabled: boolean; preview: boolean }[] = []
  let current: View | null = null
  const host = mockHost({
    requests: requests(calls, {
      'write.commit': async (input: { token: string; force: boolean }) => {
        calls.commits.push(input)
        // Le temps que le panneau se redessine : ce que la personne voit pendant l'envoi.
        await sleep(30)
        const creating = current?.find({ role: 'button', text: 'Creating…' }) ?? null
        seen.push({ creating: creating !== null, creatingDisabled: creating?.disabled === true, preview: current?.find({ type: 'List', label: 'Changes' }) != null })
        return { ok: true, value: { label: 'Applied, v1', id: 'agent_new' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  current = view
  await view.type({ label: 'Name' }, 'plugin-test-agent')
  await view.select({ label: 'Model' }, 'claude-sonnet-5')
  await view.press({ role: 'button', text: 'Create' })
  assert.deepEqual(seen, [{ creating: true, creatingDisabled: true, preview: false }])
  assert.equal(view.find({ role: 'button', text: 'Confirm' }), null)
  await view.unmount()
})

test('m5: when reading the list back fails after a successful create, the form leaves Creating and shows the error', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'write.commit': (input: { token: string; force: boolean }) => {
        calls.commits.push(input)
        return { ok: true, value: { label: 'Applied, v1', id: 'agent_new' } }
      },
      'configs.list': () => {
        throw new Error('The network dropped')
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  await view.type({ label: 'Name' }, 'plugin-test-agent')
  await view.select({ label: 'Model' }, 'claude-sonnet-5')
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.commits.length, 1)
  assert.equal(view.find({ role: 'button', text: 'Creating…' }), null)
  assert.ok(view.find({ type: 'Callout', text: /The network dropped/ }))
  // L'agent existe : la saisie gardée ne peut pas le recréer.
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('m5: when reading the detail back fails after a successful update, the review is not left busy and the error shows', async () => {
  const calls = newCalls()
  let reads = 0
  const host = mockHost({
    requests: requests(calls, {
      'configs.detail': ({ id }: { id: string }) => {
        calls.details.push(id)
        reads += 1
        if (reads > 1) throw new Error('The detail could not be read')
        return { ok: true, value: DETAIL }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, ' More.')
  await view.press({ role: 'button', text: 'Review changes' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(calls.commits.length, 1)
  assert.equal(view.find({ role: 'button', text: 'Confirm' }), null)
  assert.ok(view.find({ type: 'Callout', text: /The detail could not be read/ }))
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('leaving an agent screen drops the results already read and keeps every write in flight and every review', () => {
  const prepared: PreparedWrite = { token: 'plugin-test-token-QUOKKA-xyz', changes: [], totalChanges: 0, creates: false }
  const kept = withoutTransientFlows({
    a: { step: 'preparing' },
    b: { step: 'creating' },
    c: { step: 'review', prepared, busy: true, error: null },
    d: { step: 'conflict', prepared, busy: true, message: 'm' },
    e: { step: 'applied', label: 'Applied, v2' },
    f: { step: 'notice', tone: 'danger', title: 't', message: 'm' },
    g: { step: 'review', prepared, busy: false, error: null },
    h: { step: 'conflict', prepared, busy: false, message: 'm' }
  })
  assert.deepEqual(Object.keys(kept), ['a', 'b', 'c', 'd', 'g', 'h'])
})

test('leaving the view while a Create is in flight keeps Create disabled, so the agent is created once', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'write.commit': async (input: { token: string; force: boolean }) => {
        calls.commits.push(input)
        await sleep(120)
        return { ok: true, value: { label: 'Applied, v1', id: 'agent_new' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  await view.type({ label: 'Name' }, 'plugin-test-agent')
  await view.select({ label: 'Model' }, 'claude-sonnet-5')
  // L'envoi part sans être attendu : on sort de l'écran pendant que `write.commit` est en vol.
  const pressing = view.press({ role: 'button', text: 'Create' })
  await sleep(50)
  assert.equal(calls.commits.length, 1)
  leaveAgentView()
  await sleep(10)
  // Au retour, la saisie gardée est encore là : Create reste grisé tant que le premier envoi n'a pas atterri.
  const creating = view.find({ role: 'button', text: 'Creating…' })
  assert.ok(creating)
  assert.equal(creating.disabled, true)
  // Un second appui pendant le vol est refusé (bouton grisé) : une seule préparation, un seul `write.commit`.
  await assert.rejects(view.press({ role: 'button', text: /Creat/ }), /disabled/)
  await pressing
  assert.equal(calls.prepares.length, 1)
  assert.equal(calls.commits.length, 1)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'agent', id: 'agent_new' }])
  await view.unmount()
})

test('after a write the old base never shows while the list and the detail are read again', async () => {
  const calls = newCalls()
  const written: AgentDetail = { ...DETAIL, version: 6, form: { ...FORM, description: 'Triages incidents. More.' } }
  const seen: unknown[] = []
  let current: View | null = null
  const host = mockHost({
    requests: requests(calls, {
      'configs.detail': ({ id }: { id: string }) => {
        calls.details.push(id)
        return { ok: true, value: calls.commits.length > 0 ? written : DETAIL }
      },
      'configs.list': async ({ kind }: { kind: ConfigKind }) => {
        calls.lists.push(kind)
        // La relecture de la liste qui suit l'écriture, une fois l'écran redessiné : jamais l'ancienne base, seulement l'agent relu.
        if (calls.commits.length > 0) {
          await sleep(30)
          seen.push(current?.valueOf({ label: 'Description' }))
        }
        return { ok: true, value: kind === 'agent' ? ROWS : [] }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  current = view
  await view.type({ label: 'Description' }, ' More.')
  await view.press({ role: 'button', text: 'Review changes' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.deepEqual(seen, ['Triages incidents. More.'])
  assert.deepEqual(read(formDrafts), {})
  assert.ok(view.find({ text: 'Applied, v6' }))
  await view.unmount()
})

test('New agent from YAML opens the agent draft flow and the applied agent opens from Committed.id', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'write.commit': (input: { token: string; force: boolean }) => {
        calls.commits.push(input)
        return { ok: true, value: { label: 'Applied, v1', id: 'agent_new' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  assert.equal(button(view, 'New agent from YAML')?.props.variant, 'outline')
  await view.press({ role: 'button', text: 'New agent from YAML' })
  assert.deepEqual(calls.opens, [{ kind: 'agent', agentId: null }])
  await view.press({ role: 'button', text: 'Apply' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(calls.commits.length, 1)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'agent', id: 'agent_new' }])
  assert.deepEqual(calls.details, ['agent_new'])
  // Le résultat de l'application suit sur le détail du nouvel agent, avec son « Back to ».
  assert.ok(view.find({ type: 'Callout', text: /Applied, v1/ }))
  assert.ok(button(view, 'Back to orca'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Generate with Claude is disabled, explained, and presses nothing', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  const generate = button(view, 'Generate with Claude')
  assert.ok(generate)
  assert.equal(generate.disabled, true)
  const note = view.find({ text: 'Coming in a later version' })
  assert.ok(note)
  assert.equal(note.props.muted, true)
  const before = host.calls.length
  await view.press(generate).catch(() => {})
  assert.equal(host.calls.length, before)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
