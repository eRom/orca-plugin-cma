import { Stack } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import type { DraftInfo, DraftRef, DraftsProject, FieldChange, PreparedWrite } from '../protocol'
import { ChangesPreview, describeChange } from './changes'
import { DraftControls, DraftsSection, draftKey, loadDraftControls, loadDraftsSection } from './drafts'
import { run } from './state'

const REF: DraftRef = { kind: 'agent', agentId: 'agent_a' }
const FOLDER = '/Users/someone/.config/agent-claude-managed/managed-agents'
const SAVED_AT = '2026-11-22T10:42:00Z'

const INFO: DraftInfo = {
  ref: REF,
  file: 'writer--agent_a.yaml',
  unapplied: false,
  writtenAt: '2026-11-22T10:00:00Z',
  savedAt: '2026-11-22T10:00:00Z',
  returnTo: { workspaceId: 'ws_orca', name: 'orca' }
}
const UNAPPLIED: DraftInfo = { ...INFO, unapplied: true, savedAt: SAVED_AT }

const PREPARED: PreparedWrite = {
  token: 'plugin-test-token-QUOKKA-xyz',
  changes: [
    { path: 'name', before: 'Writer', after: 'Editor', lines: null },
    { path: 'system', before: 'a\nb', after: 'a\nc', lines: { added: 1, removed: 1 } }
  ],
  totalChanges: 2,
  creates: false
}

const CONFLICT = { ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it.' } as const
const EXPIRED = { ok: false, code: 'expired', error: 'This review expired: press Apply again.' } as const

/** Local `HH:MM` of an ISO time, written apart from the implementation. */
function localClock(iso: string): string {
  const at = new Date(iso)
  return `${at.getHours().toString().padStart(2, '0')}:${at.getMinutes().toString().padStart(2, '0')}`
}

function Controls() {
  return (
    <Stack>
      <DraftControls draftRef={REF} label="Edit YAML" />
    </Stack>
  )
}

/** What a view hosting the controls does: load once. */
const harness = {
  default: Controls,
  setup() {
    run(() => loadDraftControls(REF))
  }
}

type Calls = {
  order: string[]
  statuses: number
  opens: DraftRef[]
  discards: DraftRef[]
  commits: { token: string; force: boolean }[]
  backs: unknown[]
}

function newCalls(): Calls {
  return { order: [], statuses: 0, opens: [], discards: [], commits: [], backs: [] }
}

type Setup = {
  ready?: boolean
  info?: DraftInfo | null
  prepare?: unknown
  commits?: unknown[]
}

/** The fake worker: the scripted answers, in order for commits, and a record of what it received. */
function requests(calls: Calls, setup: Setup = {}, state: { ready: boolean } = { ready: setup.ready ?? true }) {
  const commits = [...(setup.commits ?? [{ ok: true, value: { label: 'Applied' } }])]
  return {
    'drafts.status': () => {
      calls.statuses += 1
      return { folder: FOLDER, ready: state.ready }
    },
    'draft.state': { ok: true, value: setup.info === undefined ? null : setup.info },
    'draft.open': (input: DraftRef) => {
      calls.order.push('open')
      calls.opens.push(input)
      return { ok: true, value: INFO }
    },
    'draft.discard': (input: DraftRef) => {
      calls.order.push('discard')
      calls.discards.push(input)
      return { ok: true, value: INFO }
    },
    'draft.prepare': () => {
      calls.order.push('prepare')
      return setup.prepare ?? { ok: true, value: PREPARED }
    },
    'write.commit': (input: { token: string; force: boolean }) => {
      calls.order.push('commit')
      calls.commits.push(input)
      return commits.length > 1 ? commits.shift() : commits[0]
    },
    'workspace.back': (input: unknown) => {
      calls.backs.push(input)
      return { ok: true, value: null }
    }
  } as never
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type View = Awaited<ReturnType<typeof mount>>

/** Opens the review of a kept draft: the kept draft is already there, Apply asks the worker. */
async function applyFlow(view: View): Promise<void> {
  await view.press({ role: 'button', text: 'Apply' })
}

test('draftKey is stable and tells drafts apart', () => {
  assert.equal(draftKey({ kind: 'agent', agentId: 'agent_a' }), 'agent:agent_a')
  assert.equal(draftKey({ kind: 'agent', agentId: null }), 'agent:new')
  assert.equal(draftKey({ kind: 'memory', memoryStoreId: 'ms', memoryId: 'm1', path: '/a.md' }), 'memory:ms:m1')
  assert.notEqual(
    draftKey({ kind: 'memory', memoryStoreId: 'ms', memoryId: null, path: '/a.md' }),
    draftKey({ kind: 'memory', memoryStoreId: 'ms', memoryId: null, path: '/b.md' })
  )
})

test('outside the home, a missing project points to the Drafts section', async () => {
  const calls = newCalls()
  const state = { ready: false }
  const view = await mount(harness, { host: mockHost({ requests: requests(calls, {}, state) }) })
  const card = view.find({ type: 'Callout', text: /Choose a drafts workspace/ })
  assert.ok(card)
  assert.equal(card.props.title, 'Choose a drafts workspace')
  assert.match(card.text, /Pick the Orca workspace that holds your drafts in the Drafts section of the home\./)
  // The path is no longer shown: the choice is made on the home.
  assert.equal(view.find({ type: 'CodeView' }), null)
  assert.equal(view.find({ role: 'button', text: 'Check again' }), null)
  // Without a project the draft cannot be opened.
  assert.equal(view.find({ role: 'button', text: 'Edit YAML' })?.disabled, true)
  // Nothing rereads the status by itself.
  const settled = calls.statuses
  await sleep(60)
  assert.equal(calls.statuses, settled)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the label button opens the draft, then Apply and Discard are offered', async () => {
  const calls = newCalls()
  const view = await mount(harness, { host: mockHost({ requests: requests(calls) }) })
  assert.equal(view.find({ role: 'button', text: 'Apply' }), null)
  await view.press({ role: 'button', text: 'Edit YAML' })
  assert.deepEqual(calls.opens, [REF])
  assert.ok(view.find({ text: /Draft open in the editor/ }))
  assert.ok(view.find({ role: 'button', text: 'Apply' }))
  assert.ok(view.find({ role: 'button', text: 'Discard' }))
  await view.unmount()
})

test('a kept draft says when it was saved and offers Apply and Discard', async () => {
  const view = await mount(harness, { host: mockHost({ requests: requests(newCalls(), { info: UNAPPLIED }) }) })
  assert.ok(view.find({ text: `Unapplied draft from ${localClock(SAVED_AT)}` }))
  assert.ok(view.find({ role: 'button', text: 'Apply' }))
  assert.ok(view.find({ role: 'button', text: 'Discard' }))
  await view.unmount()
})

test('a refused open shows a warning, and a missing project brings the Drafts section pointer back', async () => {
  const calls = newCalls()
  const state = { ready: true }
  const view = await mount(harness, {
    host: mockHost({
      requests: {
        ...(requests(calls, {}, state) as object),
        'draft.open': () => {
          state.ready = false
          return { ok: false, code: 'drafts_missing', error: 'The drafts project is not open in Orca. Choose it again in the Drafts section of the home.' }
        }
      } as never
    })
  })
  await view.press({ role: 'button', text: 'Edit YAML' })
  const warning = view.find({ type: 'Callout', text: /The drafts project is not open in Orca\./ })
  assert.ok(warning)
  assert.equal(warning.props.tone, 'warning')
  assert.ok(view.find({ type: 'Callout', text: /Choose a drafts workspace/ }))
  await view.unmount()
})

test('Apply shows the changes, and Confirm sends the token unforced and shows Applied', async () => {
  const calls = newCalls()
  const view = await mount(harness, { host: mockHost({ requests: requests(calls, { info: UNAPPLIED }) }) })
  await applyFlow(view)
  assert.deepEqual(calls.order, ['prepare'])
  assert.ok(view.find({ type: 'ListItem', label: 'name' }))
  assert.equal(view.find({ type: 'ListItem', label: 'system' })?.props.description, '+1 / −1 lines')
  await view.press({ role: 'button', text: 'Confirm' })
  assert.deepEqual(calls.order, ['prepare', 'commit'])
  assert.deepEqual(calls.commits, [{ token: PREPARED.token, force: false }])
  const done = view.find({ type: 'Callout', text: /Applied/ })
  assert.ok(done)
  assert.equal(done.props.tone, 'success')
  assert.equal(done.props.title, 'Applied')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('onApplied fires once when the write is applied, not on a conflict or another refusal', async () => {
  const calls = newCalls()
  let applied = 0
  const WithCallback = {
    default: () => (
      <Stack>
        <DraftControls draftRef={REF} label="Edit YAML" onApplied={() => (applied += 1)} />
      </Stack>
    ),
    setup: harness.setup
  }
  const refused = { ok: false, code: 'other', error: 'The API is down.' }
  const view = await mount(WithCallback, {
    host: mockHost({ requests: requests(calls, { info: UNAPPLIED, commits: [CONFLICT, refused, { ok: true, value: { label: 'Applied' } }] }) })
  })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(applied, 0)
  await view.press({ role: 'button', text: 'Apply anyway' })
  assert.equal(applied, 0)
  assert.ok(view.find({ type: 'Callout', text: /Could not apply/ }))
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(applied, 1)
  assert.ok(view.find({ type: 'Callout', text: /Applied/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the version label of the worker is shown as is', async () => {
  const view = await mount(harness, {
    host: mockHost({ requests: requests(newCalls(), { info: UNAPPLIED, commits: [{ ok: true, value: { label: 'Applied, v6' } }] }) })
  })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(view.find({ type: 'Callout', text: /Applied, v6/ })?.props.title, 'Applied, v6')
  await view.unmount()
})

test('Cancel closes the review without sending anything', async () => {
  const calls = newCalls()
  const view = await mount(harness, { host: mockHost({ requests: requests(calls, { info: UNAPPLIED }) }) })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Cancel' })
  assert.deepEqual(calls.commits, [])
  assert.equal(view.find({ type: 'ListItem' }), null)
  assert.ok(view.find({ role: 'button', text: 'Apply' }))
  await view.unmount()
})

test('a conflict offers Reload and Apply anyway, and Apply anyway sends the same token forced', async () => {
  const calls = newCalls()
  const view = await mount(harness, {
    host: mockHost({ requests: requests(calls, { info: UNAPPLIED, commits: [CONFLICT, { ok: true, value: { label: 'Applied' } }] }) })
  })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  const notice = view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ })
  assert.ok(notice)
  assert.equal(notice.props.tone, 'warning')
  assert.ok(view.find({ role: 'button', text: 'Reload' }))
  await view.press({ role: 'button', text: 'Apply anyway' })
  assert.deepEqual(calls.commits, [
    { token: PREPARED.token, force: false },
    { token: PREPARED.token, force: true }
  ])
  assert.ok(view.find({ type: 'Callout', text: /Applied/ }))
  await view.unmount()
})

test('Reload after a conflict discards the draft and leaves the conflict', async () => {
  const calls = newCalls()
  const view = await mount(harness, { host: mockHost({ requests: requests(calls, { info: UNAPPLIED, commits: [CONFLICT] }) }) })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  await view.press({ role: 'button', text: 'Reload' })
  assert.deepEqual(calls.discards, [REF])
  assert.equal(view.find({ role: 'button', text: 'Apply anyway' }), null)
  assert.ok(view.find({ role: 'button', text: 'Edit YAML' }))
  await view.unmount()
})

test('a long API message in a conflict is cut so the title stays under the render limit', async () => {
  const long = { ok: false, code: 'conflict', error: 'x'.repeat(5_000) } as const
  const view = await mount(harness, { host: mockHost({ requests: requests(newCalls(), { info: UNAPPLIED, commits: [long] }) }) })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  const title = view.find({ type: 'Callout', text: /xxxx/ })?.props.title as string
  assert.ok(new TextEncoder().encode(title).length <= 200)
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('an expired review shows its message in a warning, and Apply asks again', async () => {
  const calls = newCalls()
  const view = await mount(harness, { host: mockHost({ requests: requests(calls, { info: UNAPPLIED, commits: [EXPIRED] }) }) })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  const warning = view.find({ type: 'Callout', text: /This review expired: press Apply again\./ })
  assert.ok(warning)
  assert.equal(warning.props.tone, 'warning')
  assert.equal(view.find({ role: 'button', text: 'Confirm' }), null)
  await view.press({ role: 'button', text: 'Apply' })
  assert.deepEqual(calls.order, ['prepare', 'commit', 'prepare'])
  await view.unmount()
})

test('nothing to apply and an invalid draft show their message in a warning', async () => {
  for (const [code, error] of [
    ['nothing_to_apply', 'Nothing to apply: save the file first (⌘S).'],
    ['invalid', 'The YAML is not valid: line 3.']
  ] as const) {
    const view = await mount(harness, {
      host: mockHost({ requests: requests(newCalls(), { info: UNAPPLIED, prepare: { ok: false, code, error } }) })
    })
    await applyFlow(view)
    const warning = view.find({ type: 'Callout', text: new RegExp(error.slice(0, 14)) })
    assert.ok(warning, code)
    assert.equal(warning.props.tone, 'warning')
    await view.unmount()
  }
})

test('any other refusal on Confirm keeps the review and the token for another try', async () => {
  const calls = newCalls()
  const view = await mount(harness, {
    host: mockHost({
      requests: requests(calls, {
        info: UNAPPLIED,
        commits: [{ ok: false, code: 'other', error: 'The API is down.' }, { ok: true, value: { label: 'Applied' } }]
      })
    })
  })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(view.find({ type: 'Callout', text: /The API is down\./ })?.props.tone, 'danger')
  await view.press({ role: 'button', text: 'Confirm' })
  assert.deepEqual(calls.commits, [
    { token: PREPARED.token, force: false },
    { token: PREPARED.token, force: false }
  ])
  assert.ok(view.find({ type: 'Callout', text: /Applied/ }))
  await view.unmount()
})

test('Confirm and Apply anyway are disabled while a commit is in flight', async () => {
  const calls = newCalls()
  const during: { confirm?: boolean | undefined; cancel?: boolean | undefined } = {}
  let view: View | undefined
  const base = requests(calls, { info: UNAPPLIED }) as Record<string, unknown>
  const host = mockHost({
    requests: {
      ...base,
      'write.commit': async (input: { token: string; force: boolean }) => {
        calls.commits.push(input)
        await sleep(20)
        during.confirm = view?.find({ role: 'button', text: 'Confirm' })?.disabled
        during.cancel = view?.find({ role: 'button', text: 'Cancel' })?.disabled
        return { ok: true, value: { label: 'Applied' } }
      }
    } as never
  })
  view = await mount(harness, { host })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(during.confirm, true)
  assert.equal(during.cancel, true)
  assert.equal(calls.commits.length, 1)
  await view.unmount()
})

test('Back to <name> switches back to the workspace the draft came from, and Done closes the success', async () => {
  const calls = newCalls()
  const view = await mount(harness, { host: mockHost({ requests: requests(calls, { info: UNAPPLIED }) }) })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  await view.press({ role: 'button', text: 'Back to orca' })
  assert.deepEqual(calls.backs, [{ workspaceId: 'ws_orca' }])
  await view.press({ role: 'button', text: 'Done' })
  assert.equal(view.find({ type: 'Callout', text: /Applied/ }), null)
  assert.ok(view.find({ role: 'button', text: 'Edit YAML' }))
  await view.unmount()
})

test('no Back button when the draft has no workspace to return to', async () => {
  const view = await mount(harness, {
    host: mockHost({ requests: requests(newCalls(), { info: { ...UNAPPLIED, returnTo: null } }) })
  })
  await applyFlow(view)
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(view.find({ role: 'button', text: /^Back to/ }), null)
  assert.ok(view.find({ role: 'button', text: 'Done' }))
  await view.unmount()
})

test('Discard asks first, then discards the draft and hides Apply', async () => {
  const calls = newCalls()
  const view = await mount(harness, { host: mockHost({ requests: requests(calls, { info: UNAPPLIED }) }) })
  await view.press({ role: 'button', text: 'Discard' })
  assert.deepEqual(calls.discards, [])
  await view.press({ role: 'button', text: 'Discard' })
  assert.deepEqual(calls.discards, [REF])
  assert.equal(view.find({ role: 'button', text: 'Apply' }), null)
  await view.unmount()
})

test('onDiscarded fires when the draft is discarded, by Discard or by Reload after a conflict', async () => {
  const calls = newCalls()
  let discarded = 0
  const WithCallback = {
    default: () => (
      <Stack>
        <DraftControls draftRef={REF} label="Edit YAML" onDiscarded={() => (discarded += 1)} />
      </Stack>
    ),
    setup: harness.setup
  }
  const view = await mount(WithCallback, { host: mockHost({ requests: requests(calls, { info: UNAPPLIED, commits: [CONFLICT] }) }) })
  await view.press({ role: 'button', text: 'Discard' })
  assert.equal(discarded, 0)
  await view.press({ role: 'button', text: 'Discard' })
  assert.equal(discarded, 1)
  await view.unmount()

  const again = await mount(WithCallback, { host: mockHost({ requests: requests(newCalls(), { info: UNAPPLIED, commits: [CONFLICT] }) }) })
  await applyFlow(again)
  await again.press({ role: 'button', text: 'Confirm' })
  assert.equal(discarded, 1)
  await again.press({ role: 'button', text: 'Reload' })
  assert.equal(discarded, 2)
  await again.unmount()
})

test('the preview rows say before to after, or the lines, and a reorder is not +0 / −0', () => {
  const change = (over: Partial<FieldChange>): FieldChange => ({ path: 'p', before: 'a', after: 'b', lines: null, ...over })
  assert.equal(describeChange(change({})), 'a → b')
  assert.equal(describeChange(change({ lines: { added: 3, removed: 1 } })), '+3 / −1 lines')
  assert.equal(describeChange(change({ before: 'x\ny', after: 'y\nx', lines: { added: 0, removed: 0 } })), 'x\ny → y\nx')
  assert.equal(describeChange(change({ before: null })), 'Added: b')
  assert.equal(describeChange(change({ after: null })), 'Removed: a')
  assert.equal(describeChange(change({ before: null, after: '' })), 'Added: (empty)')
})

test('a long review keeps every label under the render limit and says how many changes it shows', async () => {
  const long = 'é'.repeat(2_000)
  const changes: FieldChange[] = Array.from({ length: 50 }, (_, index) => ({
    path: index === 0 ? long : `tools.${index}.name`,
    before: index === 1 ? null : long,
    after: long,
    lines: index === 2 ? { added: 12, removed: 3 } : null
  }))
  const prepared: PreparedWrite = { token: 't', changes, totalChanges: 250, creates: false }
  const view = await mount(() => <ChangesPreview prepared={prepared} busy={false} onConfirm={() => {}} onCancel={() => {}} />, {
    host: mockHost()
  })
  assert.deepEqual(view.errors, [])
  assert.equal(view.findAll({ type: 'ListItem' }).length, 50)
  assert.ok(view.find({ text: 'Showing the first 50 of 250 changes.' }))
  for (const item of view.findAll({ type: 'ListItem' })) {
    for (const value of [item.props.title, item.props.description]) {
      assert.ok(new TextEncoder().encode(String(value)).length <= 1_000, 'a label stays under 1 KiB')
    }
  }
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Confirm and Cancel call back, and are disabled while busy', async () => {
  const pressed: string[] = []
  const element = (busy: boolean) => (
    <ChangesPreview prepared={PREPARED} busy={busy} onConfirm={() => pressed.push('confirm')} onCancel={() => pressed.push('cancel')} />
  )
  const idle = await mount(() => element(false), { host: mockHost() })
  await idle.press({ role: 'button', text: 'Confirm' })
  await idle.press({ role: 'button', text: 'Cancel' })
  assert.deepEqual(pressed, ['confirm', 'cancel'])
  assert.equal(idle.find({ text: /Showing the first/ }), null)
  await idle.unmount()
  const busy = await mount(() => element(true), { host: mockHost() })
  assert.equal(busy.find({ role: 'button', text: 'Confirm' })?.disabled, true)
  assert.equal(busy.find({ role: 'button', text: 'Cancel' })?.disabled, true)
  await busy.unmount()
})

// --- Drafts section of the home ---

const ALPHA: DraftsProject = { id: 'p_alpha', name: 'alpha', path: '/x/alpha', current: false }
const BETA: DraftsProject = { id: 'p_beta', name: 'beta', path: '/x/beta', current: false }

type ChooseResult = { ok: true; value: { folder: string; ready: boolean } } | { ok: false; code: string; error: string }

/** The fake worker of the section: `current` is the chosen project id, moved by a successful `drafts.choose`. */
function sectionRequests(state: { current: string | null; reads: number; chosen: string[]; choose?: ChooseResult }) {
  return {
    'drafts.projects': () => {
      state.reads += 1
      return { ok: true, value: [ALPHA, BETA].map((project) => ({ ...project, current: project.id === state.current })) }
    },
    'drafts.choose': (input: { projectId: string }) => {
      state.chosen.push(input.projectId)
      const result = state.choose ?? { ok: true, value: { folder: `/x/${input.projectId}/managed-agents`, ready: true } }
      if (result.ok) state.current = input.projectId
      return result
    }
  } as never
}

const sectionHarness = {
  default: DraftsSection,
  setup() {
    run(loadDraftsSection)
  }
}

test('without a project, Drafts shows the empty view', async () => {
  const state = { current: null, reads: 0, chosen: [] }
  const view = await mount(sectionHarness, { host: mockHost({ requests: sectionRequests(state) }) })
  assert.equal(view.find({ type: 'Collapsible' })?.props.title, 'Drafts')
  assert.equal(view.find({ type: 'EmptyState' })?.props.title, 'No drafts workspace')
  assert.equal(
    view.find({ type: 'EmptyState' })?.props.description,
    "Edit agents and memories as files in Orca's editor. They live in a folder workspace you choose."
  )
  assert.ok(view.find({ role: 'button', text: 'Add Orca workspace' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('Add Orca workspace lists the projects and Cancel closes them', async () => {
  const state = { current: null, reads: 0, chosen: [] }
  const view = await mount(sectionHarness, { host: mockHost({ requests: sectionRequests(state) }) })
  assert.equal(state.reads, 1)
  await view.press({ role: 'button', text: 'Add Orca workspace' })
  assert.ok(view.find({ text: 'Choose a workspace' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Use alpha' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Use beta' }))
  assert.equal(view.findAll({ type: 'IconButton' }).length, 2)
  assert.equal(view.find({ type: 'EmptyState', text: /No drafts workspace/ }), null)
  await view.press({ role: 'button', text: 'Cancel' })
  assert.equal(view.find({ text: 'Choose a workspace' }), null)
  // Opening the list reads the projects again each time.
  await view.press({ role: 'button', text: 'Add Orca workspace' })
  assert.equal(state.reads, 3)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('choosing a project shows it with Change workspace', async () => {
  const state = { current: null, reads: 0, chosen: [] as string[] }
  const view = await mount(sectionHarness, { host: mockHost({ requests: sectionRequests(state) }) })
  await view.press({ role: 'button', text: 'Add Orca workspace' })
  await view.press({ type: 'IconButton', label: 'Use alpha' })
  assert.deepEqual(state.chosen, ['p_alpha'])
  assert.equal(view.find({ text: 'Choose a workspace' }), null)
  assert.ok(view.find({ text: 'alpha' }))
  assert.ok(view.find({ text: '/x/alpha/managed-agents' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Change workspace' }))
  // Changing opens the list again, the current project says so and cannot be picked again.
  await view.press({ type: 'IconButton', label: 'Change workspace' })
  assert.ok(view.find({ text: 'Current' }))
  assert.equal(view.find({ type: 'IconButton', label: 'Use alpha' }), null)
  assert.ok(view.find({ type: 'IconButton', label: 'Use beta' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a refused move keeps the list and shows why', async () => {
  const error = 'The folder already holds other files: move them away first.'
  const state = { current: null, reads: 0, chosen: [] as string[], choose: { ok: false, code: 'drafts_occupied', error } as ChooseResult }
  const view = await mount(sectionHarness, { host: mockHost({ requests: sectionRequests(state) }) })
  await view.press({ role: 'button', text: 'Add Orca workspace' })
  await view.press({ type: 'IconButton', label: 'Use alpha' })
  const refusal = view.find({ type: 'Callout', text: new RegExp(error) })
  assert.ok(refusal)
  assert.equal(refusal.props.tone, 'danger')
  assert.equal(refusal.props.title, 'Could not change the drafts workspace')
  // The list stays open, with nothing chosen.
  assert.ok(view.find({ text: 'Choose a workspace' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Use beta' }))
  // Cancel closes the list and the refusal with it.
  await view.press({ role: 'button', text: 'Cancel' })
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('folded, Drafts sums up the project', async () => {
  const chosen = await mount(sectionHarness, {
    host: mockHost({ requests: sectionRequests({ current: 'p_alpha', reads: 0, chosen: [] }) }),
    persisted: { plugin: { draftsSectionOpen: false } }
  })
  assert.equal(chosen.find({ type: 'Collapsible' })?.props.description, 'alpha')
  await chosen.unmount()
  const unset = await mount(sectionHarness, {
    host: mockHost({ requests: sectionRequests({ current: null, reads: 0, chosen: [] }) }),
    persisted: { plugin: { draftsSectionOpen: false } }
  })
  assert.equal(unset.find({ type: 'Collapsible' })?.props.description, 'Not set')
  await unset.unmount()
})

test('a failed projects read shows the empty view and no error', async () => {
  const view = await mount(sectionHarness, {
    host: mockHost({ requests: { 'drafts.projects': { ok: false, code: 'other', error: 'Orca is not reachable.' } } as never })
  })
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})
