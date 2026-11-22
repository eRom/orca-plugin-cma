import { assert, mockHost, mount, test } from 'orca/testing'
import type { AgentDetail, ConfigDetail, ConfigKind, ConfigRow, EnvironmentDetail, MemoryStoreDetail, VaultDetail } from '../protocol'
import * as panel from '../panel'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: 'Check Org'
}

const AGENT_ROWS: ConfigRow[] = [
  { kind: 'agent', id: 'agent_a', name: 'Incident commander', summary: 'v3 · claude-haiku-5-5' },
  { kind: 'agent', id: 'agent_w', name: 'Writer', summary: 'v1 · claude-sonnet-5' }
]

const ROWS: Record<ConfigKind, ConfigRow[]> = {
  agent: AGENT_ROWS,
  environment: [{ kind: 'environment', id: 'env_a', name: 'Sandbox', summary: 'cloud · unrestricted' }],
  memory_store: [{ kind: 'memory_store', id: 'memstore_a', name: 'Notes', summary: '2 memories' }],
  vault: [
    { kind: 'vault', id: 'vlt_a', name: 'GitHub', summary: '1 credential' },
    { kind: 'vault', id: 'vlt_b', name: 'Slack', summary: '2 credentials' }
  ]
}

const AGENT: AgentDetail = {
  kind: 'agent',
  id: 'agent_a',
  name: 'Incident commander',
  version: 3,
  model: 'claude-haiku-5-5',
  effort: 'high',
  description: 'Triages incidents.',
  system: { text: 'You are an incident commander.', truncated: false },
  builtinTools: {
    enabled: true,
    policy: 'always_allow',
    overrides: [{ name: 'web_search', enabled: false, policy: null }]
  },
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

const STORE: MemoryStoreDetail = {
  kind: 'memory_store',
  id: 'memstore_a',
  name: 'Notes',
  description: 'Runbooks of the team.',
  memories: [
    { id: 'mem_a', path: 'runbooks/deploy.md', sizeBytes: 2048, updatedAt: '2026-11-20T10:00:00Z' },
    { id: 'mem_b', path: 'runbooks/rollback.md', sizeBytes: 300, updatedAt: '2026-11-21T10:00:00Z' }
  ]
}

const VAULT: VaultDetail = {
  kind: 'vault',
  id: 'vlt_a',
  name: 'GitHub',
  credentials: [
    { id: 'vcrd_a', name: 'GitHub OAuth', type: 'mcp_oauth', mcpServerUrl: 'https://api.githubcopilot.com/mcp/', expiresAt: '2027-01-01T00:00:00Z' },
    { id: 'vcrd_b', name: 'DEPLOY_TOKEN', type: 'environment_variable', mcpServerUrl: null, expiresAt: null }
  ]
}

function environment(network: EnvironmentDetail['network']): EnvironmentDetail {
  return {
    kind: 'environment',
    id: 'env_a',
    name: 'Sandbox',
    hosting: network.mode === 'host_managed' ? 'self_hosted' : 'cloud',
    network,
    packages: [{ key: 'pip', value: 'requests' }],
    metadata: [{ key: 'team', value: 'infra' }]
  }
}

/** Les demandes communes ; `over` remplace ou complète. */
function requests(over: Record<string, unknown> = {}) {
  return {
    'workspace.info': WITH_KEY,
    'sessions.visibility': { bootId: 'boot-1', watching: null },
    'sessions.list': { ok: true, value: [] },
    'configs.list': ({ kind }: { kind: ConfigKind }) => ({ ok: true, value: ROWS[kind] }),
    ...over
  } as never
}

/** Le type actif du sélecteur : le seul bouton plein de la rangée. */
function activeKind(view: Awaited<ReturnType<typeof mount>>): string[] {
  return ['Agents', 'Envs', 'Memory', 'Vaults'].filter(
    (label) => view.find({ role: 'button', text: label })?.props.variant === 'solid'
  )
}

function openConfig(kind: ConfigKind, id: string) {
  return { plugin: { nav: [{ view: 'home' }, { view: 'config', kind, id }] } }
}

test('filters the agent list', async () => {
  const host = mockHost({ requests: requests() })
  const view = await mount(panel, { host })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  await view.type({ label: 'Filter' }, 'inci')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  assert.ok(view.find({ type: 'ListItem', label: 'Incident commander' }))
  // Sans tenir compte de la casse, et sur l'identifiant aussi.
  await view.type({ label: 'Filter' }, 'INCI', { replace: true })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.type({ label: 'Filter' }, 'agent_w', { replace: true })
  assert.ok(view.find({ type: 'ListItem', label: 'Writer' }))
  await view.type({ label: 'Filter' }, 'zzz', { replace: true })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  assert.ok(view.find({ type: 'EmptyState' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows an empty state when a tab has nothing', async () => {
  const host = mockHost({ requests: requests({ 'configs.list': { ok: true, value: [] } }) })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'EmptyState', label: 'Nothing here yet' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows a list error with a short title and the API text inside', async () => {
  const host = mockHost({ requests: requests({ 'configs.list': { ok: false, code: 'other', error: 'x'.repeat(5000) } }) })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Callout', text: /Could not load the list/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('opens a vault and comes back to the same tab', async () => {
  const detailCalls: unknown[] = []
  const host = mockHost({
    requests: requests({
      'configs.detail': (input: unknown) => {
        detailCalls.push(input)
        return { ok: true, value: VAULT }
      }
    })
  })
  const view = await mount(panel, { host })
  assert.deepEqual(activeKind(view), ['Agents'])
  await view.press({ role: 'button', text: 'Vaults' })
  assert.deepEqual(activeKind(view), ['Vaults'])
  await view.press({ type: 'ListItem', label: 'GitHub' })
  assert.deepEqual(detailCalls, [{ kind: 'vault', id: 'vlt_a' }])
  // Le coffre liste ses identifiants, sans secret.
  assert.ok(view.find({ type: 'ListItem', label: 'GitHub OAuth' }))
  assert.ok(view.find({ type: 'ListItem', label: 'DEPLOY_TOKEN' }))
  assert.ok(view.find({ text: /Environment variable/ }))
  await view.press({ role: 'button', text: /Back/ })
  assert.deepEqual(activeKind(view), ['Vaults'])
  assert.ok(view.find({ type: 'ListItem', label: 'Slack' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('keeps the filter when coming back from a detail', async () => {
  const host = mockHost({ requests: requests({ 'configs.detail': { ok: true, value: AGENT } }) })
  const view = await mount(panel, { host })
  await view.type({ label: 'Filter' }, 'inci')
  await view.press({ type: 'ListItem', label: 'Incident commander' })
  assert.equal(view.find({ label: 'Filter' }), null)
  await view.press({ role: 'button', text: /Back/ })
  const filter = view.find({ label: 'Filter' })
  assert.ok(filter)
  assert.equal(view.valueOf(filter), 'inci')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.unmount()
})

test('shows the agent detail with its tools and servers', async () => {
  const host = mockHost({ requests: requests({ 'configs.detail': { ok: true, value: AGENT } }), })
  const view = await mount(panel, { host, persisted: openConfig('agent', 'agent_a') })
  assert.ok(view.find({ text: 'Incident commander' }))
  assert.ok(view.find({ type: 'Code', text: 'agent_a' }))
  assert.ok(view.find({ text: /claude-haiku-5-5/ }))
  assert.ok(view.find({ text: /high/ }))
  const prompt = view.find({ type: 'CodeView' })
  assert.ok(prompt)
  assert.equal(prompt.props.code, 'You are an incident commander.')
  // Outils intégrés : politique par défaut puis outils réglés un par un.
  assert.ok(view.find({ type: 'Card', label: 'Built-in tools' }))
  assert.ok(view.find({ text: /web_search/ }))
  // Serveur MCP : nom, URL, politique par défaut.
  const server = view.find({ type: 'Card', label: 'github' })
  assert.ok(server)
  assert.ok(server.text.includes('always ask'))
  assert.ok(server.text.includes('list_commits'))
  assert.ok(view.find({ text: /skill_triage/ }))
  assert.ok(view.find({ text: /advisor claude-opus-5/ }))
  assert.equal(view.find({ text: 'Truncated, open in Console for the full text' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the truncation notice', async () => {
  const truncated: AgentDetail = { ...AGENT, system: { text: 'You are an incident commander.', truncated: true } }
  const host = mockHost({ requests: requests({ 'configs.detail': { ok: true, value: truncated } }) })
  const view = await mount(panel, { host, persisted: openConfig('agent', 'agent_a') })
  assert.ok(view.find({ text: 'Truncated, open in Console for the full text' }))
  await view.unmount()
})

test('opens the console page of the item with a press', async () => {
  const host = mockHost({ requests: requests({ 'configs.detail': { ok: true, value: AGENT } }) })
  const view = await mount(panel, { host, persisted: openConfig('agent', 'agent_a') })
  assert.deepEqual(host.callsOf('shell.openExternal'), [])
  await view.press({ role: 'button', text: /Open in Console/ })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: 'https://platform.claude.com/workspaces/wrkspc_x/agents/agent_a' }])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('describes the three environment networks', async () => {
  const cases: [EnvironmentDetail['network'], RegExp][] = [
    [{ mode: 'unrestricted' }, /Unrestricted/],
    [{ mode: 'limited', allowedHosts: ['pypi.org', 'github.com'], allowPackageManagers: true, allowMcpServers: false }, /Limited/],
    [{ mode: 'host_managed' }, /Managed by the host/]
  ]
  for (const [network, expected] of cases) {
    const host = mockHost({ requests: requests({ 'configs.detail': { ok: true, value: environment(network) } }) })
    const view = await mount(panel, { host, persisted: openConfig('environment', 'env_a') })
    assert.ok(view.find({ text: expected }), String(expected))
    if (network.mode === 'limited') {
      assert.ok(view.find({ type: 'ListItem', label: 'pypi.org' }))
      assert.ok(view.find({ type: 'ListItem', label: 'github.com' }))
    }
    assert.deepEqual(view.errors, [])
    await view.unmount()
  }
})

test('opens a memory from its store', async () => {
  const detailCalls: unknown[] = []
  const memoryCalls: unknown[] = []
  const host = mockHost({
    requests: requests({
      'configs.detail': (input: unknown) => {
        detailCalls.push(input)
        return { ok: true, value: STORE satisfies ConfigDetail }
      },
      'memory.read': (input: unknown) => {
        memoryCalls.push(input)
        return {
          ok: true,
          value: { id: 'mem_a', memoryStoreId: 'memstore_a', path: 'runbooks/deploy.md', updatedAt: '2026-11-20T10:00:00Z', content: { text: '# Deploy\n\nRun the script.', truncated: false } }
        }
      }
    })
  })
  const view = await mount(panel, { host, persisted: openConfig('memory_store', 'memstore_a') })
  assert.ok(view.find({ type: 'ListItem', label: 'runbooks/deploy.md' }))
  assert.ok(view.find({ text: /Runbooks of the team/ }))
  await view.press({ type: 'ListItem', label: 'runbooks/deploy.md' })
  assert.deepEqual(memoryCalls, [{ memoryStoreId: 'memstore_a', memoryId: 'mem_a' }])
  const markdown = view.find({ type: 'Markdown' })
  assert.ok(markdown)
  assert.equal(markdown.props.content, '# Deploy\n\nRun the script.')
  // Retour à la banque, sans relire son détail.
  await view.press({ role: 'button', text: /Back/ })
  assert.ok(view.find({ type: 'ListItem', label: 'runbooks/rollback.md' }))
  assert.equal(detailCalls.length, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('reloads the store when a restart left a memory on top of the stack', async () => {
  const detailCalls: unknown[] = []
  const host = mockHost({
    requests: requests({
      'configs.detail': (input: unknown) => {
        detailCalls.push(input)
        return { ok: true, value: STORE }
      },
      'memory.read': {
        ok: true,
        value: { id: 'mem_a', memoryStoreId: 'memstore_a', path: 'runbooks/deploy.md', updatedAt: '2026-11-20T10:00:00Z', content: { text: 'Hi', truncated: true } }
      }
    })
  })
  const persisted = { plugin: { nav: [{ view: 'home' }, { view: 'config', kind: 'memory_store', id: 'memstore_a' }, { view: 'memory', memoryStoreId: 'memstore_a', memoryId: 'mem_a' }] } }
  const view = await mount(panel, { host, persisted })
  assert.ok(view.find({ type: 'Markdown' }))
  assert.ok(view.find({ text: 'Truncated, open in Console for the full text' }))
  assert.deepEqual(detailCalls, [])
  await view.press({ role: 'button', text: /Back/ })
  assert.deepEqual(detailCalls, [{ kind: 'memory_store', id: 'memstore_a' }])
  assert.ok(view.find({ type: 'ListItem', label: 'runbooks/rollback.md' }))
  await view.unmount()
})

test('shows a long detail error without breaking the view', async () => {
  const host = mockHost({ requests: requests({ 'configs.detail': { ok: false, code: 'other', error: 'y'.repeat(5000) } }) })
  const view = await mount(panel, { host, persisted: openConfig('agent', 'agent_a') })
  assert.ok(view.find({ type: 'Callout', text: /Could not load the details/ }))
  assert.ok(view.find({ role: 'button', text: /Back/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
