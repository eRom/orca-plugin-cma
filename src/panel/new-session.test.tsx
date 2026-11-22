import { assert, mockHost, mount, test } from 'orca/testing'
import type { ConfigRow, SessionCreateInput } from '../protocol'
import * as panel from '../panel'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: 'Check Org'
}

const OPTIONS = {
  agents: [
    { kind: 'agent', id: 'agent_a', name: 'Writer', summary: 'v3' },
    { kind: 'agent', id: 'agent_b', name: 'Reviewer', summary: 'v1' }
  ] as ConfigRow[],
  environments: [{ kind: 'environment', id: 'env_a', name: 'Sandbox', summary: 'cloud' }] as ConfigRow[],
  vaults: [{ kind: 'vault', id: 'vlt_a', name: 'GitHub', summary: '1 credential' }] as ConfigRow[],
  memoryStores: [{ kind: 'memory_store', id: 'memstore_a', name: 'Notes', summary: '4 memories' }] as ConfigRow[]
}

const OPEN_FORM = { plugin: { nav: [{ view: 'home' }, { view: 'newSession' }] } }

const SESSION_ROW = {
  id: 'sesn_new',
  title: 'Created one',
  agentId: 'agent_a',
  agentName: 'Writer',
  status: 'idle',
  badge: 'idle',
  cost: { minor: '0', currency: 'USD' },
  budget: null,
  updatedAt: '2026-11-22T10:00:00Z',
  pendingApprovals: 0
}

/** Les demandes communes ; `create` remplace `session.create`. */
function requests(create: (input: unknown) => unknown, over: Record<string, unknown> = {}) {
  return {
    'workspace.info': WITH_KEY,
    'sessions.visibility': { bootId: 'boot-1', watching: null }, 'configs.list': { ok: true, value: [] },
    'sessions.list': { ok: true, value: [] },
    'createForm.options': { ok: true, value: OPTIONS },
    'session.create': create,
    'session.watch': {
      ok: true,
      value: { rows: [], hasEarlier: false, stream: { sessionId: 'sesn_new', phase: 'open', since: 0, reconnects: 0, error: null } }
    },
    'session.detail': { ok: true, value: { ...SESSION_ROW, agentVersion: 3, environmentId: 'env_a', environmentName: 'Sandbox', vaultIds: [], resources: [], createdAt: '2026-11-22T09:00:00Z' } },
    'session.leave': null,
    ...over
  }
}

test('disables create until agent and environment are chosen', async () => {
  const host = mockHost({ requests: requests(() => ({ ok: true, value: { sessionId: 'sesn_new' } })) as never })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  const create = (): boolean => view.find({ role: 'button', text: /Create session/ })?.disabled ?? false
  assert.equal(create(), true)
  await view.select({ label: 'Agent' }, 'agent_a')
  assert.equal(create(), true)
  await view.select({ label: 'Environment' }, 'env_a')
  assert.equal(create(), false)
  // Le libellé résume ce qui sera lancé.
  assert.ok(view.find({ role: 'button', text: 'Create session · Writer · Sandbox · $5.00' }))
  // Un budget saisi mais invalide bloque aussi ; vide, il veut dire sans plafond.
  await view.type({ label: 'Budget (USD)' }, 'abc', { replace: true })
  assert.equal(create(), true)
  await view.type({ label: 'Budget (USD)' }, '', { replace: true })
  assert.equal(create(), false)
  assert.ok(view.find({ role: 'button', text: 'Create session · Writer · Sandbox · no budget' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('sends the typed budget in dollars and opens the new session', async () => {
  const calls: unknown[] = []
  const host = mockHost({
    requests: requests((input) => {
      calls.push(input)
      return { ok: true, value: { sessionId: 'sesn_new' } }
    }, { 'sessions.list': { ok: true, value: [SESSION_ROW] } }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.select({ label: 'Agent' }, 'agent_a')
  await view.select({ label: 'Environment' }, 'env_a')
  await view.type({ label: 'Title' }, ' Triage ')
  await view.toggle({ label: 'GitHub' })
  await view.toggle({ label: 'Notes' })
  await view.type({ label: 'Budget (USD)' }, '0.50', { replace: true })
  await view.type({ label: 'First message' }, 'Hello agent')
  await view.press({ role: 'button', text: /Create session/ })
  const expected: SessionCreateInput = {
    agentId: 'agent_a',
    environmentId: 'env_a',
    title: 'Triage',
    vaultIds: ['vlt_a'],
    memoryStoreIds: ['memstore_a'],
    budgetDollars: '0.50',
    firstMessage: 'Hello agent'
  }
  assert.deepEqual(calls, [expected])
  // La vue de la session remplace le formulaire.
  assert.equal(view.find({ role: 'button', text: /Create session/ }), null)
  assert.ok(view.find({ text: 'Created one' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('sends no budget and no optional fields when they are left empty', async () => {
  const calls: unknown[] = []
  const host = mockHost({
    requests: requests((input) => {
      calls.push(input)
      return { ok: true, value: { sessionId: 'sesn_new' } }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.select({ label: 'Agent' }, 'agent_b')
  await view.select({ label: 'Environment' }, 'env_a')
  await view.type({ label: 'Budget (USD)' }, '', { replace: true })
  await view.press({ role: 'button', text: /Create session/ })
  assert.deepEqual(calls, [
    { agentId: 'agent_b', environmentId: 'env_a', title: null, vaultIds: [], memoryStoreIds: [], budgetDollars: null, firstMessage: null }
  ])
  await view.unmount()
})

test('offers to create without budget on model_not_budgetable', async () => {
  const calls: SessionCreateInput[] = []
  const host = mockHost({
    requests: requests((input) => {
      calls.push(input as SessionCreateInput)
      return calls.length === 1
        ? { ok: false, code: 'model_not_budgetable', error: 'This model does not support a budget.' }
        : { ok: true, value: { sessionId: 'sesn_new' } }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.select({ label: 'Agent' }, 'agent_a')
  await view.select({ label: 'Environment' }, 'env_a')
  await view.press({ role: 'button', text: /Create session/ })
  assert.equal(calls[0]?.budgetDollars, '5.00')
  assert.ok(view.find({ type: 'Callout', text: /This model does not support a budget/ }))
  // Le formulaire reste ouvert, le refus n'est pas l'avis rouge du panneau.
  assert.equal(view.find({ type: 'Callout', text: /Something went wrong/ }), null)
  await view.press({ role: 'button', text: 'Create without budget' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.budgetDollars, null)
  assert.equal(calls[1]?.agentId, 'agent_a')
  assert.equal(view.find({ role: 'button', text: 'Create without budget' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('creates once per press while a creation is in flight', async () => {
  let calls = 0
  let release: (value: unknown) => void = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const host = mockHost({
    requests: requests(async () => {
      calls += 1
      await gate
      return { ok: true, value: { sessionId: 'sesn_new' } }
    }) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.select({ label: 'Agent' }, 'agent_a')
  await view.select({ label: 'Environment' }, 'env_a')
  const first = view.press({ role: 'button', text: /Create session/ })
  const second = view.press({ role: 'button', text: /Create session/ }).catch(() => undefined)
  release(null)
  await Promise.all([first, second])
  assert.equal(calls, 1)
  await view.unmount()
})

test('shows a long API error without breaking the form', async () => {
  const host = mockHost({
    requests: requests(() => ({ ok: false, code: 'other', error: 'x'.repeat(5000) })) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.select({ label: 'Agent' }, 'agent_a')
  await view.select({ label: 'Environment' }, 'env_a')
  await view.press({ role: 'button', text: /Create session/ })
  assert.ok(view.find({ type: 'Callout', text: /Could not create the session/ }))
  assert.equal(view.find({ role: 'button', text: 'Create without budget' }), null)
  assert.ok(view.find({ role: 'button', text: /Create session/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('goes back to the home view', async () => {
  const host = mockHost({ requests: requests(() => ({ ok: true, value: { sessionId: 'sesn_new' } })) as never })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.press({ role: 'button', text: /Back/ })
  assert.ok(view.find({ role: 'button', text: 'New session' }))
  assert.equal(view.find({ label: 'Agent' }), null)
  await view.unmount()
})

test('opens the form from the home button', async () => {
  const host = mockHost({ requests: requests(() => ({ ok: true, value: { sessionId: 'sesn_new' } })) as never })
  const view = await mount(panel, { host })
  await view.press({ role: 'button', text: 'New session' })
  assert.ok(view.find({ label: 'Agent' }))
  assert.ok(view.find({ label: 'Environment' }))
  assert.equal(view.valueOf({ label: 'Budget (USD)' }), '5.00')
  await view.unmount()
})

test('restarts with a clean form and fresh lists, ignoring stale persisted ids', async () => {
  const persisted = {
    plugin: {
      nav: [{ view: 'home' }, { view: 'newSession' }],
      'newSession.agentId': 'agent_gone',
      'newSession.environmentId': 'env_gone',
      'newSession.vaultIds': ['vlt_gone'],
      'newSession.firstMessage': 'Old draft'
    }
  }
  let reads = 0
  const host = mockHost({
    requests: requests(() => ({ ok: true, value: { sessionId: 'sesn_new' } }), {
      'createForm.options': () => {
        reads += 1
        return { ok: true, value: OPTIONS }
      }
    }) as never
  })
  const view = await mount(panel, { host, persisted })
  assert.equal(reads, 1)
  assert.equal(view.valueOf({ label: 'Agent' }), '')
  assert.equal(view.valueOf({ label: 'First message' }), '')
  assert.equal(view.valueOf({ label: 'Budget (USD)' }), '5.00')
  assert.equal(view.find({ role: 'button', text: /Create session/ })?.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('removes the budget warning and its button when the agent changes', async () => {
  const host = mockHost({
    requests: requests(() => ({ ok: false, code: 'model_not_budgetable', error: 'This model does not support a budget.' })) as never
  })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.select({ label: 'Agent' }, 'agent_a')
  await view.select({ label: 'Environment' }, 'env_a')
  await view.press({ role: 'button', text: /Create session/ })
  assert.ok(view.find({ role: 'button', text: 'Create without budget' }))
  await view.select({ label: 'Agent' }, 'agent_b')
  assert.equal(view.find({ role: 'button', text: 'Create without budget' }), null)
  assert.equal(view.find({ type: 'Callout', text: /does not support a budget/ }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('accepts a 20 KB first message without a refused render or persist', async () => {
  const host = mockHost({ requests: requests(() => ({ ok: true, value: { sessionId: 'sesn_new' } })) as never })
  const view = await mount(panel, { host, persisted: OPEN_FORM })
  await view.type({ label: 'First message' }, 'word '.repeat(4000))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
