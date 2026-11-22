import { assert, mockHost, mount, test } from 'orca/testing'
import type { SessionDetail, SessionRow, StreamState, ThreadRow, ToolState } from '../protocol'
import * as panel from '../panel'
import { set } from 'orca'
import { restoreOpenSession } from './session-view'
import { sending, sessionNotice } from './state'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: 'Check Org'
}

const OPEN_STREAM: StreamState = { sessionId: 's1', phase: 'open', since: 0, reconnects: 0, error: null }

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1',
    title: 'Triage run',
    agentId: 'agent_x',
    agentName: 'Writer',
    status: 'idle',
    badge: 'idle',
    cost: { minor: '125', currency: 'USD' },
    budget: { minor: '50', currency: 'USD' },
    updatedAt: '2026-11-22T10:00:00Z',
    pendingApprovals: 0,
    ...over
  }
}

function sessionDetail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    ...sessionRow(),
    agentVersion: 3,
    environmentId: 'env_x',
    environmentName: 'Sandbox',
    vaultIds: ['vlt_x'],
    resources: ['memory store: notes'],
    createdAt: '2026-11-22T09:00:00Z',
    ...over
  }
}

function message(id: string, text = `message ${id}`, kind: 'user_message' | 'agent_message' = 'agent_message'): ThreadRow {
  return { id, at: null, kind, text: { text, truncated: false } }
}

function tool(id: string, state: ToolState, needsConfirmation = false): ThreadRow {
  return {
    id,
    at: null,
    kind: 'tool',
    name: 'list_commits',
    server: 'github',
    input: { text: '{"repo":"anthropics/sdk"}', truncated: false },
    result: null,
    state,
    needsConfirmation
  }
}

type Overrides = Record<string, unknown>

/** Les demandes communes à toutes les vues de session ; `over` en remplace ou en ajoute. */
function requests(rows: ThreadRow[], over: Overrides = {}, hasEarlier = false) {
  return {
    'workspace.info': WITH_KEY,
    'sessions.visibility': { bootId: 'boot-1', watching: 's1' }, 'configs.list': { ok: true, value: [] },
    'sessions.list': { ok: true, value: [sessionRow()] },
    'session.watch': { ok: true, value: { rows, hasEarlier, stream: OPEN_STREAM } },
    'session.detail': { ok: true, value: sessionDetail() },
    'session.leave': null,
    ...over
  }
}

const OPEN_S1 = { plugin: { nav: [{ view: 'home' }, { view: 'session', sessionId: 's1' }] } }

test('renders a pending approval with Allow and Deny', async () => {
  const calls: unknown[] = []
  const host = mockHost({
    requests: requests([tool('toolu_1', 'awaiting_approval', true)], {
      'session.confirm': (input: unknown) => {
        calls.push(input)
        return { ok: true, value: null }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ type: 'Collapsible', text: /github\.list_commits/ }))
  assert.ok(view.find({ type: 'Callout', text: /Allow/ }))
  assert.ok(view.find({ role: 'button', text: 'Deny' }))
  await view.press({ role: 'button', text: 'Allow' })
  assert.deepEqual(calls, [{ sessionId: 's1', toolUseId: 'toolu_1', allow: true, denyMessage: null }])
  // Le bouton disparaît une fois l'accord parti : pas de second envoi possible.
  assert.equal(view.find({ role: 'button', text: 'Allow' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('sends the deny reason with Deny', async () => {
  const calls: unknown[] = []
  const host = mockHost({
    requests: requests([tool('toolu_1', 'awaiting_approval', true)], {
      'session.confirm': (input: unknown) => {
        calls.push(input)
        return { ok: true, value: null }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.type({ label: 'Deny reason (optional)' }, 'Not this repo')
  await view.press({ role: 'button', text: 'Deny' })
  assert.deepEqual(calls, [{ sessionId: 's1', toolUseId: 'toolu_1', allow: false, denyMessage: 'Not this repo' }])
  await view.unmount()
})

test('restores the open session after a restart', async () => {
  const watched: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1', 'Hello there')], {
      'session.watch': (input: unknown) => {
        watched.push(input)
        return { ok: true, value: { rows: [message('m1', 'Hello there')], hasEarlier: false, stream: OPEN_STREAM } }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.deepEqual(watched, [{ sessionId: 's1' }])
  assert.ok(view.find({ text: 'Triage run' }))
  assert.ok(view.find({ text: /Hello there/ }))
  assert.ok(view.find({ role: 'button', text: /Back/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('pages back and returns to latest', async () => {
  const rows = Array.from({ length: 150 }, (_, index) => message(`m${index}`, `row-${index}-text`))
  const host = mockHost({ requests: requests(rows) as never })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ text: /row-149-text/ }))
  assert.equal(view.find({ text: /row-10-text/ }), null)
  assert.equal(view.find({ role: 'button', text: 'Latest' }), null)
  await view.press({ role: 'button', text: 'Load earlier' })
  assert.ok(view.find({ role: 'button', text: 'Latest' }))
  assert.ok(view.find({ text: /row-10-text/ }))
  assert.equal(view.find({ text: /row-149-text/ }), null)
  await view.press({ role: 'button', text: 'Latest' })
  assert.ok(view.find({ text: /row-149-text/ }))
  assert.equal(view.find({ role: 'button', text: 'Latest' }), null)
  await view.unmount()
})

test('loads older rows from the worker when the loaded rows run out', async () => {
  const asked: unknown[] = []
  const host = mockHost({
    requests: requests([message('m5', 'row-5-text'), message('m6', 'row-6-text')], {
      'session.loadEarlier': (input: unknown) => {
        asked.push(input)
        return { ok: true, value: { rows: [message('m3', 'row-3-text'), message('m4', 'row-4-text')], hasEarlier: false } }
      }
    }, true) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.press({ role: 'button', text: 'Load earlier' })
  assert.deepEqual(asked, [{ sessionId: 's1', beforeId: 'm5' }])
  assert.ok(view.find({ text: /row-3-text/ }))
  assert.equal(view.find({ role: 'button', text: 'Load earlier' }), null)
  // La page remontée remplace la fin : `Latest` ramène aux lignes les plus récentes.
  await view.press({ role: 'button', text: 'Latest' })
  assert.ok(view.find({ text: /row-6-text/ }))
  await view.unmount()
})

test('shows Load earlier on the first open when the worker reports older rows', async () => {
  const host = mockHost({ requests: requests([message('m1')], { 'session.watch': { ok: true, value: { rows: [], hasEarlier: false, stream: OPEN_STREAM } } }) as never })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.equal(view.find({ role: 'button', text: 'Load earlier' }), null)
  await view.post('session.thread', { sessionId: 's1', rows: [message('m1', 'tail row')], previews: [], hasEarlier: true })
  assert.ok(view.find({ role: 'button', text: 'Load earlier' }))
  assert.ok(view.find({ text: /tail row/ }))
  await view.unmount()
})

test('merges pushed rows by id and ignores other sessions', async () => {
  const host = mockHost({ requests: requests([message('m1', 'first draft'), message('m2', 'second')]) as never })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.post('session.thread', { sessionId: 's1', rows: [message('m1', 'first final'), message('m3', 'third')], previews: [{ id: 'p1', text: 'typing now' }] })
  assert.equal(view.find({ text: /first draft/ }), null)
  assert.ok(view.find({ text: /first final/ }))
  assert.ok(view.find({ text: /third/ }))
  assert.ok(view.find({ text: /typing now/ }))
  await view.post('session.thread', { sessionId: 'other', rows: [message('x1', 'stranger')], previews: [] })
  assert.equal(view.find({ text: /stranger/ }), null)
  await view.unmount()
})

test('hides the composer for a terminated session', async () => {
  const gone = sessionRow({ status: 'terminated', badge: 'terminated' })
  const host = mockHost({
    requests: requests([message('m1')], {
      'sessions.list': { ok: true, value: [gone] },
      'session.detail': { ok: true, value: sessionDetail({ status: 'terminated', badge: 'terminated' }) }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ text: /message m1/ }))
  assert.equal(view.find({ label: 'Message' }), null)
  assert.equal(view.find({ role: 'button', text: 'Send' }), null)
  await view.unmount()
})

test('enables Interrupt only while the session runs', async () => {
  const interrupts: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1')], {
      'session.interrupt': (input: unknown) => {
        interrupts.push(input)
        return { ok: true, value: null }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.equal(view.find({ role: 'button', text: 'Interrupt' })?.disabled, true)
  await view.post('sessions.changed', { rows: [sessionRow({ status: 'running', badge: 'running' })] })
  const button = view.find({ role: 'button', text: 'Interrupt' })
  assert.equal(button?.disabled, false)
  await view.press({ role: 'button', text: 'Interrupt' })
  assert.deepEqual(interrupts, [{ sessionId: 's1' }])
  await view.unmount()
})

test('sends a message and clears the draft', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1')], {
      'session.send': (input: unknown) => {
        sent.push(input)
        return { ok: true, value: null }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.equal(view.find({ role: 'button', text: 'Send' })?.disabled, true)
  await view.type({ label: 'Message' }, '  Do the thing ')
  await view.press({ role: 'button', text: 'Send' })
  assert.deepEqual(sent, [{ sessionId: 's1', text: 'Do the thing' }])
  const field = view.find({ label: 'Message' })
  assert.ok(field)
  assert.equal(view.valueOf(field), '')
  await view.unmount()
})

test('takes the header badge from the sessions list and the cost from session.updated', async () => {
  const host = mockHost({ requests: requests([message('m1')]) as never })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ type: 'Badge', text: 'Idle' }))
  assert.ok(view.find({ text: /\$1\.25 \/ \$0\.50/ }))
  await view.post('sessions.changed', { rows: [sessionRow({ status: 'idle', badge: 'needs_approval', pendingApprovals: 1 })] })
  assert.ok(view.find({ type: 'Badge', text: 'Needs approval' }))
  await view.post('session.updated', {
    sessionId: 's1',
    // Le statut de cette poussée n'est qu'indicatif : le badge reste celui de la liste.
    status: 'running',
    badge: 'running',
    cost: { minor: '300', currency: 'USD' },
    budget: { minor: '50', currency: 'USD' }
  })
  assert.ok(view.find({ text: /\$3\.00 \/ \$0\.50/ }))
  assert.ok(view.find({ type: 'Badge', text: 'Needs approval' }))
  await view.unmount()
})

test('raises the budget from the Budget reached callout', async () => {
  const raised: unknown[] = []
  const stopped = sessionRow({ status: 'idle', badge: 'budget_reached' })
  const host = mockHost({
    requests: requests([message('m1')], {
      'sessions.list': { ok: true, value: [stopped] },
      'session.raiseBudget': (input: unknown) => {
        raised.push(input)
        return { ok: true, value: sessionDetail({ budget: { minor: '1000', currency: 'USD' } }) }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ type: 'Callout', text: /Budget reached/ }))
  await view.type({ label: 'New budget limit ($)' }, 'abc')
  await view.press({ role: 'button', text: 'Raise budget' })
  assert.deepEqual(raised, [])
  assert.ok(view.find({ text: /positive amount in dollars/ }))
  await view.type({ label: 'New budget limit ($)' }, '10', { replace: true })
  await view.press({ role: 'button', text: 'Raise budget' })
  assert.deepEqual(raised, [{ sessionId: 's1', dollars: '10' }])
  assert.ok(view.find({ text: /\$1\.25 \/ \$10\.00/ }))
  await view.unmount()
})

test('leaves the session with Back', async () => {
  const left: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1')], {
      'session.leave': (input: unknown) => {
        left.push(input)
        return null
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.press({ role: 'button', text: /Back/ })
  assert.deepEqual(left, [{ sessionId: 's1' }])
  assert.ok(view.find({ role: 'button', text: 'New session' }))
  await view.unmount()
})

test('shows an API error raw above the composer', async () => {
  const host = mockHost({
    requests: requests([message('m1')], {
      'session.send': { ok: false, code: 'other', error: 'Session is archived.' }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.type({ label: 'Message' }, 'hello')
  await view.press({ role: 'button', text: 'Send' })
  assert.ok(view.find({ type: 'Callout', text: /Session is archived\./ }))
  await view.unmount()
})

test('windows an 800 KB thread under the render caps and offers Load earlier', async () => {
  const rows = Array.from({ length: 50 }, (_, index) => message(`h${index}`, `${index}:${'x'.repeat(16_000)}`))
  const host = mockHost({ requests: requests(rows) as never })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ role: 'button', text: 'Load earlier' }))
  assert.ok(view.find({ text: /^49:/ }))
  assert.equal(view.find({ text: /^0:/ }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('loads a restored session once a rejected key is replaced', async () => {
  const watched: unknown[] = []
  const detailed: unknown[] = []
  let infoCalls = 0
  const host = mockHost({
    requests: requests([message('m1', 'Back again')], {
      'workspace.info': () => {
        infoCalls += 1
        return infoCalls === 1 ? { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null } : WITH_KEY
      },
      'key.set': { ok: true, value: WITH_KEY },
      'session.watch': (input: unknown) => {
        watched.push(input)
        return { ok: true, value: { rows: [message('m1', 'Back again')], hasEarlier: false, stream: OPEN_STREAM } }
      },
      'session.detail': (input: unknown) => {
        detailed.push(input)
        return { ok: true, value: sessionDetail() }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  // Clé refusée : l'accueil montre le formulaire, aucune session n'est chargée.
  assert.ok(view.find({ label: 'API key' }))
  assert.deepEqual(watched, [])
  await view.type({ label: 'API key' }, 'sk-ant-fresh')
  await view.press({ role: 'button', text: 'Save key' })
  assert.deepEqual(watched, [{ sessionId: 's1' }])
  assert.deepEqual(detailed, [{ sessionId: 's1' }])
  assert.ok(view.find({ text: /Back again/ }))
  await view.unmount()
})

test('sends a message once on a double submit', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1')], {
      'session.send': async (input: unknown) => {
        sent.push(input)
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { ok: true, value: null }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.type({ label: 'Message' }, 'Run it')
  const field = { label: 'Message' }
  await Promise.all([view.submit(field), view.submit(field)])
  assert.equal(sent.length, 1)
  await view.unmount()
})

test('renders a 5000-character API error without a refused render', async () => {
  const long = 'E'.repeat(5_000)
  const host = mockHost({
    requests: requests([message('m1')], { 'session.send': { ok: false, code: 'other', error: long } }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.type({ label: 'Message' }, 'hello')
  await view.press({ role: 'button', text: 'Send' })
  assert.ok(view.find({ type: 'Callout', text: /EEEE/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('renders a 5000-character panel notice without a refused render', async () => {
  const long = 'F'.repeat(5_000)
  const host = mockHost({
    requests: requests([message('m1')], { 'sessions.list': { ok: false, code: 'other', error: long } }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ type: 'Callout', text: /FFFF/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('reopens the watch when the worker restarted behind an open session', async () => {
  const watched: unknown[] = []
  const detailed: unknown[] = []
  let pings = 0
  const host = mockHost({
    requests: requests([message('m1')], {
      // Premier ping : worker b1 qui suit s1 ; second ping (après la restauration) : worker b2, neuf.
      'sessions.visibility': () => {
        pings += 1
        return pings === 1 ? { bootId: 'b1', watching: 's1' } : { bootId: 'b2', watching: null }
      },
      'session.watch': (input: unknown) => {
        watched.push(input)
        return { ok: true, value: { rows: [message('m1')], hasEarlier: false, stream: OPEN_STREAM } }
      },
      'session.detail': (input: unknown) => {
        detailed.push(input)
        return { ok: true, value: sessionDetail() }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.settled()
  assert.ok(pings >= 2)
  assert.deepEqual(watched, [{ sessionId: 's1' }, { sessionId: 's1' }])
  assert.deepEqual(detailed, [{ sessionId: 's1' }, { sessionId: 's1' }])
  assert.ok(view.find({ text: /message m1/ }))
  await view.unmount()
})

// Un ping qui annonce un worker redémarré rouvre la session affichée. `orca/testing` attend toute
// requête en cours avant de rendre la main : la réouverture est donc déclenchée ici directement.
test('keeps the typed message when the open session is reopened behind it', async () => {
  const watched: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1')], {
      'session.watch': (input: unknown) => {
        watched.push(input)
        return { ok: true, value: { rows: [message('m1')], hasEarlier: false, stream: OPEN_STREAM } }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.type({ label: 'Message' }, 'Half-written thought')
  await restoreOpenSession()
  await view.settled()
  assert.deepEqual(watched, [{ sessionId: 's1' }, { sessionId: 's1' }])
  const field = view.find({ label: 'Message' })
  assert.ok(field)
  assert.equal(view.valueOf(field), 'Half-written thought')
  await view.unmount()
})

// Un envoi encore en route au moment de la réouverture garde Send bloqué, et l'erreur affichée reste :
// sans elle, le texte gardé inviterait à renvoyer un message peut-être déjà facturé.
test('keeps the send guard and the notice when the open session is reopened', async () => {
  const host = mockHost({ requests: requests([message('m1')]) as never })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.type({ label: 'Message' }, 'Pending message')
  set(sending, true)
  set(sessionNotice, 'Worker unavailable')
  await restoreOpenSession()
  await view.settled()
  assert.equal(view.find({ role: 'button', text: 'Send' })?.disabled, true)
  assert.ok(view.find({ text: /Worker unavailable/ }))
  await view.unmount()
})

test('clips an oversized session title in the header', async () => {
  const long = 'T'.repeat(5000)
  const host = mockHost({
    requests: requests([message('m1')], {
      'sessions.list': { ok: true, value: [sessionRow({ title: long })] },
      'session.detail': { ok: true, value: sessionDetail({ title: long }) }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  const title = view.find({ text: /^T+/ })
  assert.ok(title)
  assert.ok(title.text.length < 1000)
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('reopens the watch when the worker follows no session although the thread is open', async () => {
  const watched: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1')], {
      'sessions.visibility': { bootId: 'b1', watching: null },
      'session.watch': (input: unknown) => {
        watched.push(input)
        return { ok: true, value: { rows: [message('m1')], hasEarlier: false, stream: OPEN_STREAM } }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.settled()
  assert.deepEqual(watched, [{ sessionId: 's1' }, { sessionId: 's1' }])
  await view.unmount()
})

test('leaves the watch alone when the worker already follows the open session', async () => {
  const watched: unknown[] = []
  const host = mockHost({
    requests: requests([message('m1')], {
      'sessions.visibility': { bootId: 'b1', watching: 's1' },
      'session.watch': (input: unknown) => {
        watched.push(input)
        return { ok: true, value: { rows: [message('m1')], hasEarlier: false, stream: OPEN_STREAM } }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.settled()
  assert.deepEqual(watched, [{ sessionId: 's1' }])
  await view.unmount()
})

test('shows a spinner instead of "No messages yet." while the stream connects', async () => {
  const connecting: StreamState = { sessionId: 's1', phase: 'connecting', since: 0, reconnects: 0, error: null }
  const host = mockHost({
    requests: {
      ...requests([], {}),
      'session.watch': { ok: true, value: { rows: [], hasEarlier: false, stream: connecting } }
    } as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.equal(view.find({ text: 'No messages yet.' }), null)
  assert.ok(view.find({ type: 'Spinner', label: 'Connecting' }))
  await view.post('stream.state', OPEN_STREAM)
  assert.ok(view.find({ text: 'No messages yet.' }))
  assert.equal(view.find({ type: 'Spinner' }), null)
  await view.unmount()
})

test('disables the composer on a budget-reached session with a hint', async () => {
  const stopped = sessionRow({ status: 'idle', badge: 'budget_reached' })
  const host = mockHost({
    requests: requests([message('m1')], { 'sessions.list': { ok: true, value: [stopped] } }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  assert.ok(view.find({ text: 'Raise the budget to continue.' }))
  assert.equal(view.find({ role: 'button', text: 'Send' })?.disabled, true)
  assert.equal(view.find({ label: 'Message' })?.disabled, true)
  // Le budget relevé rend le composeur : le badge repasse à `idle`.
  await view.post('sessions.changed', { rows: [sessionRow({ status: 'idle', badge: 'idle' })] })
  assert.equal(view.find({ text: 'Raise the budget to continue.' }), null)
  assert.equal(view.find({ label: 'Message' })?.disabled, false)
  await view.unmount()
})

test('clips an oversized budget raise error', async () => {
  const stopped = sessionRow({ status: 'idle', badge: 'budget_reached' })
  const host = mockHost({
    requests: requests([message('m1')], {
      'sessions.list': { ok: true, value: [stopped] },
      'session.raiseBudget': { ok: false, code: 'other', error: 'R'.repeat(30_000) }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  await view.type({ label: 'New budget limit ($)' }, '10')
  await view.press({ role: 'button', text: 'Raise budget' })
  const shown = view.findAll({ text: /RRRR/ })
  assert.ok(shown.length > 0)
  assert.ok(shown.every((element) => element.text.length < 9_000))
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('windows 400 small rows to at most 100 and offers Load earlier', async () => {
  const rows = Array.from({ length: 400 }, (_, index) => message(`m${index}`, `row-${index}-text`))
  const host = mockHost({ requests: requests(rows) as never })
  const view = await mount(panel, { host, persisted: OPEN_S1 })
  const shown = view.findAll({ type: 'Markdown' }).length
  assert.ok(shown > 0 && shown <= 100)
  assert.ok(view.find({ text: /row-399-text/ }))
  assert.ok(view.find({ role: 'button', text: 'Load earlier' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
