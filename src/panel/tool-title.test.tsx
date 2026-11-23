import { assert, mockHost, mount, test } from 'orca/testing'
import type { SessionDetail, SessionRow, StreamState, ThreadRow } from '../protocol'
import * as panel from '../panel'

const OPEN_STREAM: StreamState = { sessionId: 's1', phase: 'open', since: 0, reconnects: 0, error: null }

const row: SessionRow = {
  id: 's1',
  title: 'Triage run',
  agentId: 'agent_x',
  agentName: 'Writer',
  status: 'idle',
  badge: 'idle',
  cost: null,
  budget: null,
  updatedAt: '2026-11-22T10:00:00Z',
  pendingApprovals: 0
}

const detail: SessionDetail = {
  ...row,
  agentVersion: 1,
  environmentId: 'env_x',
  environmentName: 'Sandbox',
  vaultIds: [],
  resources: [],
  createdAt: '2026-11-22T09:00:00Z'
}

const longTool: ThreadRow = {
  id: 't1',
  at: null,
  kind: 'tool',
  name: 'x'.repeat(2_000),
  server: 's'.repeat(100),
  input: { text: '{}', truncated: false },
  result: null,
  state: 'done',
  needsConfirmation: false
}

test('clips an oversized tool title in the thread', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': { hasKey: true, keyRejected: false, workspaceId: 'wrkspc_x', organizationName: 'Org', workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }] },
      'sessions.visibility': { bootId: 'boot-1', watching: 's1' },
      'configs.list': { ok: true, value: [] },
      'sessions.list': { ok: true, value: [row] },
      'session.watch': { ok: true, value: { rows: [longTool], hasEarlier: false, stream: OPEN_STREAM } },
      'session.detail': { ok: true, value: detail },
      'session.leave': null
    } as never
  })
  const view = await mount(panel, { host, persisted: { plugin: { nav: [{ view: 'home' }, { view: 'session', sessionId: 's1' }] } } })
  const collapsible = view.find({ type: 'Collapsible' })
  assert.ok(collapsible)
  assert.equal(typeof collapsible.props.title, 'string')
  assert.ok(new TextEncoder().encode(String(collapsible.props.title)).length < 1024)
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
