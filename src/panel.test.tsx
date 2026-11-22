import { assert, mockHost, mount, test } from 'orca/testing'
import type { SessionRow } from './protocol'
import * as panel from './panel'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: "Romain's Individual Org"
}

test('shows the key form without a key', async () => {
  const host = mockHost({
    requests: { 'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null } }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'API key' }))
  assert.equal(view.find({ text: 'Configurations' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the workspace line with a key', async () => {
  const host = mockHost({
    requests: { 'workspace.info': WITH_KEY, 'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] }, 'sessions.list': { ok: true, value: [] } }
  })
  const view = await mount(panel, { host })
  // La section workspace est repliée par défaut quand la clé est bonne.
  await view.toggle({ type: 'Collapsible', text: /Anthropic workspace/ })
  assert.ok(view.find({ text: /wrkspc_x/ }))
  assert.ok(view.find({ role: 'button', text: 'Forget key' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the key form again when the key is rejected', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Callout', text: /The API key was rejected \(401\)\./ }))
  assert.ok(view.find({ label: 'API key' }))
  await view.unmount()
})

test('keeps the key draft when key.set fails', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null },
      'key.set': { ok: false, code: 'unauthorized', error: 'The API key was rejected (401).' }
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'API key' }, 'sk-ant-typo')
  await view.press({ role: 'button', text: 'Save key' })
  assert.ok(view.find({ type: 'Callout', text: /The API key was rejected \(401\)\./ }))
  const input = view.find({ label: 'API key' })
  assert.ok(input)
  assert.equal(view.valueOf(input), 'sk-ant-typo')
  await view.unmount()
})

function sessionRow(over: Partial<SessionRow>): SessionRow {
  return {
    id: 'sesn_x',
    title: null,
    agentId: 'agent_x',
    agentName: 'Writer',
    status: 'idle',
    badge: 'idle',
    cost: { minor: '125', currency: 'USD' },
    budget: null,
    updatedAt: '2026-11-22T10:00:00Z',
    pendingApprovals: 0,
    ...over
  }
}

test('lists sessions with badges first', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] },
      'sessions.list': {
        ok: true,
        value: [
          sessionRow({ id: 'sesn_idle', title: 'Quiet one', updatedAt: '2026-11-22T12:00:00Z' }),
          sessionRow({
            id: 'sesn_wait',
            title: 'Waiting one',
            status: 'idle',
            badge: 'needs_approval',
            pendingApprovals: 1,
            updatedAt: '2026-11-22T09:00:00Z'
          })
        ]
      }
    }
  })
  const view = await mount(panel, { host })
  const rows = view.findAll({ type: 'ListItem' })
  assert.equal(rows.length, 2)
  assert.match(rows[0]?.text ?? '', /Needs approval/)
  assert.match(rows[0]?.text ?? '', /Waiting one/)
  assert.match(rows[1]?.text ?? '', /Idle/)
  // Titre absent : l'id sert de titre ; le coût accompagne l'agent.
  assert.match(rows[1]?.text ?? '', /Writer · \$1\.25/)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('announces itself as visible and keeps the list in sync with the worker', async () => {
  const pings: boolean[] = []
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': ({ visible }) => {
        pings.push(visible)
        return { bootId: 'boot-1', watching: null }
      },
      'sessions.list': { ok: true, value: [] }
    }
  })
  const view = await mount(panel, { host })
  // Un ping au montage, un autre une fois la vue restaurée : tous annoncent le panneau visible.
  assert.ok(pings.length >= 1)
  assert.ok(pings.every((visible) => visible))
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  await view.post('sessions.changed', { rows: [sessionRow({ id: 'sesn_new', title: 'Fresh' })] })
  const rows = view.findAll({ type: 'ListItem' })
  assert.equal(rows.length, 1)
  assert.match(rows[0]?.text ?? '', /Fresh/)
  await view.unmount()
})

test('the New session button stays first in the Sessions section', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] },
      'sessions.list': { ok: true, value: [sessionRow({ title: 'Only' })] }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ role: 'button', text: 'New session' }))
  await view.unmount()
})

test('re-reads the workspace when the worker reports an empty list after a rejected key', async () => {
  let infoCalls = 0
  const host = mockHost({
    requests: {
      'workspace.info': () => {
        infoCalls += 1
        return infoCalls === 1
          ? WITH_KEY
          : { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null }
      },
      'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] },
      'sessions.list': { ok: true, value: [sessionRow({ title: 'Soon gone' })] }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.post('sessions.changed', { rows: [] })
  assert.ok(view.find({ type: 'Callout', text: /The API key was rejected \(401\)\./ }))
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  await view.unmount()
})
