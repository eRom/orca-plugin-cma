import { assert, mockHost, mount, test } from 'orca/testing'
import type { SessionRow } from './protocol'
import * as panel from './panel'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: "Romain's Individual Org",
  workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }]
}

test('shows the key form without a key', async () => {
  const host = mockHost({
    requests: { 'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null, workspaces: [] } }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'API key' }))
  assert.equal(view.find({ text: 'Configurations' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the workspace list with a key, always open', async () => {
  const host = mockHost({
    requests: { 'workspace.info': WITH_KEY, 'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] }, 'sessions.list': { ok: true, value: [] } }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Default' }))
  assert.ok(view.find({ text: /wrkspc_x/ }))
  assert.ok(view.find({ type: 'Badge', text: 'Active' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('marks the active workspace Key rejected and opens Replace key when the key is rejected', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null, workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }] }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Badge', text: 'Key rejected' }))
  assert.ok(view.find({ label: 'Replace key' }))
  await view.unmount()
})

test('keeps the key draft when workspaces.add fails', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null, workspaces: [] },
      'workspaces.add': { ok: false, code: 'unauthorized', error: 'The API key was rejected (401).' }
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

test('the New session button stays first in the Sessions tab', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] },
      'sessions.list': { ok: true, value: [sessionRow({ title: 'Only' })] }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'IconButton', label: 'New session' }))
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
          : { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null, workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }] }
      },
      'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] },
      'sessions.list': { ok: true, value: [sessionRow({ title: 'Soon gone' })] }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.post('sessions.changed', { rows: [] })
  assert.ok(view.find({ type: 'Badge', text: 'Key rejected' }))
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  await view.unmount()
})

test('clips oversized session labels so Orca still renders the home', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true, value: [] },
      'sessions.list': {
        ok: true,
        value: [sessionRow({ id: 'sesn_long', title: 'T'.repeat(5000), agentName: 'A'.repeat(5000) })]
      }
    }
  })
  const view = await mount(panel, { host })
  const rows = view.findAll({ type: 'ListItem' })
  assert.equal(rows.length, 1)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
  assert.ok((rows[0]?.text.length ?? 0) < 1000)
  await view.unmount()
})

test('opens on the Sessions tab, with no Configurations or Sessions section to fold', async () => {
  const kinds: unknown[] = []
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': ({ kind }: { kind: string }) => {
        kinds.push(kind)
        return { ok: true, value: [] }
      },
      'sessions.list': { ok: true, value: [sessionRow({ id: 'sesn_a', title: 'First' })] }
    }
  })
  const view = await mount(panel, { host })
  const tabs = ['Sessions', 'Agents', 'Envs', 'Memory', 'Vaults']
  assert.deepEqual(
    tabs.filter((label) => view.find({ role: 'button', text: label })?.props.variant === 'solid'),
    ['Sessions']
  )
  assert.ok(view.find({ type: 'IconButton', label: 'New session' }))
  assert.ok(view.find({ type: 'ListItem', text: /First/ }))
  // Plus aucune section ne se replie.
  assert.deepEqual(view.findAll({ type: 'Collapsible' }), [])
  // L'onglet Sessions ne lit aucune liste de configuration.
  assert.deepEqual(kinds, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('switching tabs reads the chosen list, and coming back to Sessions rereads the sessions', async () => {
  const kinds: unknown[] = []
  let sessionReads = 0
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': ({ kind }: { kind: string }) => {
        kinds.push(kind)
        return { ok: true, value: [{ kind: 'agent', id: 'agent_a', name: 'Writer', summary: 'v1' }] }
      },
      'sessions.list': () => {
        sessionReads += 1
        return { ok: true, value: [] }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ role: 'button', text: 'Agents' })
  assert.deepEqual(kinds, ['agent'])
  assert.ok(view.find({ type: 'IconButton', label: 'New agent' }))
  assert.equal(view.find({ type: 'IconButton', label: 'New session' }), null)
  assert.equal(view.persisted.plugin['home.tab'], 'agent')
  const before = sessionReads
  await view.press({ role: 'button', text: 'Sessions' })
  assert.ok(sessionReads > before)
  assert.ok(view.find({ type: 'IconButton', label: 'New session' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('filters the sessions by title, id or agent, and says so when nothing matches', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'sessions.list': {
        ok: true,
        value: [
          sessionRow({ id: 'sesn_a', title: 'Deploy check', agentName: 'Incident commander' }),
          sessionRow({ id: 'sesn_b', title: 'Notes', agentName: 'Writer' })
        ]
      }
    }
  })
  const view = await mount(panel, { host })
  // Le « + » de création est un bouton en contour, à droite du filtre.
  assert.equal(view.find({ type: 'IconButton', label: 'New session' })?.props.variant, 'outline')
  await view.type({ label: 'Filter' }, 'INCIDENT')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  assert.ok(view.find({ type: 'ListItem', text: /Deploy check/ }))
  await view.type({ label: 'Filter' }, 'sesn_b', { replace: true })
  assert.ok(view.find({ type: 'ListItem', text: /Notes/ }))
  await view.type({ label: 'Filter' }, 'zzz', { replace: true })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  assert.ok(view.find({ type: 'EmptyState', label: 'No match' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
