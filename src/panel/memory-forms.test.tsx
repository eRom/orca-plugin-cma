import { read, update } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import type {
  ConfigKind,
  ConfigRow,
  DraftInfo,
  DraftRef,
  MemoryContent,
  MemoryRenameInput,
  MemoryStoreDetail,
  MemoryStoreForm,
  SaveInput
} from '../protocol'
import * as panel from '../panel'
import { INVALID_MEMORY_PATH } from '../shared/memory-path'
import { formDrafts } from './form-state'
import { nav, notice, popView } from './state'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: 'Check Org'
}

const CONFLICT = { ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it.' } as const
const FOLDER = '/Users/someone/.config/agent-claude-managed/managed-agents'

const FORM: MemoryStoreForm = { name: 'Notes', description: 'Runbooks of the team.' }

const STORE: MemoryStoreDetail = {
  kind: 'memory_store',
  id: 'memstore_a',
  name: 'Notes',
  description: 'Runbooks of the team.',
  updatedAt: '2026-11-21T10:00:00Z',
  form: FORM,
  memories: [
    { id: 'mem_a', path: '/runbooks/deploy.md', sizeBytes: 2048, updatedAt: '2026-11-20T10:00:00Z' },
    { id: 'mem_b', path: '/runbooks/rollback.md', sizeBytes: 300, updatedAt: '2026-11-21T10:00:00Z' }
  ]
}

const MEMORY: MemoryContent = {
  id: 'mem_a',
  memoryStoreId: 'memstore_a',
  path: '/runbooks/deploy.md',
  updatedAt: '2026-11-20T10:00:00Z',
  sha256: 'sha-one',
  content: { text: '# Deploy\n\nRun the script.', truncated: false }
}

const ROWS: ConfigRow[] = [{ kind: 'memory_store', id: 'memstore_a', name: 'Notes', summary: '2 memories' }]

const OPEN_STORE = { plugin: { nav: [{ view: 'home' }, { view: 'config', kind: 'memory_store', id: 'memstore_a' }] } }
const OPEN_NEW_STORE = { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'memory_store' }] } }
const OPEN_MEMORY = {
  plugin: {
    nav: [
      { view: 'home' },
      { view: 'config', kind: 'memory_store', id: 'memstore_a' },
      { view: 'memory', memoryStoreId: 'memstore_a', memoryId: 'mem_a' }
    ]
  }
}

const PREPARED = {
  token: 'plugin-test-token-QUOKKA-xyz',
  changes: [{ path: 'content', before: 'a', after: 'b', lines: { added: 1, removed: 1 } }],
  totalChanges: 1,
  creates: false
}

/** Ce que le faux worker a reçu, dans l'ordre. */
type Calls = {
  saves: SaveInput<MemoryStoreForm>[]
  lists: ConfigKind[]
  details: string[]
  reads: unknown[]
  renames: MemoryRenameInput[]
  archives: unknown[]
  deletes: unknown[]
  states: DraftRef[]
  commits: unknown[]
}

function newCalls(): Calls {
  return { saves: [], lists: [], details: [], reads: [], renames: [], archives: [], deletes: [], states: [], commits: [] }
}

/** L'état de l'API que le faux worker rejoue : une écriture le change, la relecture suivante le montre. */
type World = { store: MemoryStoreDetail; memory: MemoryContent }

function newWorld(): World {
  return { store: STORE, memory: MEMORY }
}

/** Les demandes communes ; `over` remplace ou complète. */
function requests(calls: Calls, world: World, over: Record<string, unknown> = {}) {
  const info: DraftInfo = {
    ref: { kind: 'memory', memoryStoreId: 'memstore_a', memoryId: 'mem_a', path: '/runbooks/deploy.md' },
    file: 'memories/notes--memstore_a/runbooks/deploy.md',
    unapplied: true,
    writtenAt: '2026-11-22T10:00:00Z',
    savedAt: '2026-11-22T10:42:00Z',
    returnTo: null
  }
  return {
    'workspace.info': WITH_KEY,
    'sessions.visibility': { bootId: 'boot-1', watching: null },
    'sessions.list': { ok: true, value: [] },
    'configs.list': ({ kind }: { kind: ConfigKind }) => {
      calls.lists.push(kind)
      return { ok: true, value: kind === 'memory_store' ? ROWS : [] }
    },
    'configs.detail': ({ id }: { id: string }) => {
      calls.details.push(id)
      return { ok: true, value: id === 'memstore_new' ? { ...STORE, id: 'memstore_new', name: 'plugin-test-store', form: { name: 'plugin-test-store', description: '' }, memories: [] } : world.store }
    },
    'memory.read': (input: unknown) => {
      calls.reads.push(input)
      return { ok: true, value: world.memory }
    },
    'memoryStore.save': (input: SaveInput<MemoryStoreForm>) => {
      calls.saves.push(input)
      return { ok: true, value: { id: input.id ?? 'memstore_new', updatedAt: '2026-11-22T11:00:00Z' } }
    },
    'memory.rename': (input: MemoryRenameInput) => {
      calls.renames.push(input)
      world.memory = { ...world.memory, path: input.path, sha256: 'sha-two' }
      return { ok: true, value: { id: input.memoryId, updatedAt: '2026-11-22T11:00:00Z' } }
    },
    'resource.archive': (input: unknown) => {
      calls.archives.push(input)
      return { ok: true, value: null }
    },
    'resource.delete': (input: unknown) => {
      calls.deletes.push(input)
      return { ok: true, value: null }
    },
    'drafts.status': { folder: FOLDER, ready: true },
    'draft.state': (input: DraftRef) => {
      calls.states.push(input)
      return { ok: true, value: input.kind === 'memory' && input.memoryId === 'mem_a' ? info : null }
    },
    'draft.discard': (input: DraftRef) => ({ ok: true, value: { ...info, ref: input, unapplied: false } }),
    'draft.prepare': { ok: true, value: PREPARED },
    'write.commit': (input: unknown) => {
      calls.commits.push(input)
      return { ok: true, value: { label: 'Applied' } }
    },
    ...over
  } as never
}

type View = Awaited<ReturnType<typeof mount>>

// --- Banque : formulaire ---

test('creates a memory store, then opens its detail', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_NEW_STORE })
  assert.ok(view.find({ text: 'New memory store' }))
  const create = (): boolean => view.find({ role: 'button', text: 'Create' })?.disabled ?? false
  assert.equal(create(), true)
  await view.type({ label: 'Name' }, 'plugin-test-store')
  assert.equal(create(), false)
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.saves.length, 1)
  const sent = calls.saves[0]
  assert.ok(sent)
  assert.equal(sent.id, null)
  assert.equal(sent.base, null)
  assert.equal(sent.baseUpdatedAt, null)
  assert.equal(sent.force, false)
  assert.deepEqual(sent.form, { name: 'plugin-test-store', description: '' })
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'memory_store', id: 'memstore_new' }])
  assert.deepEqual(calls.details, ['memstore_new'])
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a new memory store flags its missing name only after the field was touched', async () => {
  const host = mockHost({ requests: requests(newCalls(), newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_NEW_STORE })
  assert.equal(view.find({ label: 'Name' })?.props.invalid, false)
  await view.type({ label: 'Name' }, 'x')
  await view.type({ label: 'Name' }, '', { replace: true })
  assert.equal(view.find({ label: 'Name' })?.props.invalid, true)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.unmount()
})

test('shows name and description as fields and saves the edit against the loaded version', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  assert.equal(view.valueOf({ label: 'Name' }), 'Notes')
  assert.equal(view.valueOf({ label: 'Description' }), 'Runbooks of the team.')
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  await view.type({ label: 'Description' }, 'Updated', { replace: true })
  assert.ok(view.find({ text: 'Unsaved changes' }))
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.saves.length, 1)
  const sent = calls.saves[0]
  assert.ok(sent)
  assert.equal(sent.id, 'memstore_a')
  assert.equal(sent.baseUpdatedAt, STORE.updatedAt)
  assert.equal(sent.force, false)
  assert.deepEqual(sent.base, FORM)
  assert.deepEqual(sent.form, { name: 'Notes', description: 'Updated' })
  // La liste puis le détail sont relus après l'écriture.
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a conflict offers Reload and Save anyway, and Save anyway forces the write', async () => {
  const calls = newCalls()
  let answers = 0
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      'memoryStore.save': (input: SaveInput<MemoryStoreForm>) => {
        calls.saves.push(input)
        answers += 1
        return answers === 1 ? CONFLICT : { ok: true, value: { id: 'memstore_a', updatedAt: '2026-11-22T12:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.type({ label: 'Description' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  assert.equal(view.valueOf({ label: 'Description' }), 'Mine')
  await view.press({ role: 'button', text: 'Save anyway' })
  assert.equal(calls.saves.length, 2)
  assert.equal(calls.saves[0]?.force, false)
  assert.equal(calls.saves[1]?.force, true)
  assert.equal(calls.saves[1]?.form.description, 'Mine')
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('Reload after a conflict rereads the detail and drops the kept input', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld(), { 'memoryStore.save': CONFLICT }) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.type({ label: 'Description' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  await view.press({ role: 'button', text: 'Reload' })
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  assert.equal(view.valueOf({ label: 'Description' }), 'Runbooks of the team.')
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a kept input started on an older version shows the conflict and Save sends that older version', async () => {
  const calls = newCalls()
  const persisted = {
    plugin: {
      ...OPEN_STORE.plugin,
      'forms.drafts': {
        'memory_store:memstore_a': {
          form: { name: 'Notes', description: 'Mine' },
          base: { name: 'Notes', description: 'Old' },
          baseStamp: '2026-11-20T09:00:00Z'
        }
      }
    }
  }
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Save anyway' })
  const sent = calls.saves[0]
  assert.ok(sent)
  assert.equal(sent.force, true)
  assert.equal(sent.baseUpdatedAt, '2026-11-20T09:00:00Z')
  assert.deepEqual(sent.base, { name: 'Notes', description: 'Old' })
  await view.unmount()
})

test('a refused save shows the reason and keeps the input', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), { 'memoryStore.save': { ok: false, code: 'invalid', error: 'The name is too long.' } })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.type({ label: 'Name' }, 'Renamed', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(view.find({ type: 'Callout', text: /Could not save/ }))
  assert.ok(view.find({ text: 'The name is too long.' }))
  assert.equal(view.valueOf({ label: 'Name' }), 'Renamed')
  await view.unmount()
})

test('the fields are disabled while a save is in flight', async () => {
  const calls = newCalls()
  const seen: Record<string, boolean | undefined> = {}
  let view: View | undefined
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      'memoryStore.save': async (input: SaveInput<MemoryStoreForm>) => {
        calls.saves.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        seen.name = view?.find({ label: 'Name' })?.disabled
        seen.description = view?.find({ label: 'Description' })?.disabled
        return { ok: true, value: { id: 'memstore_a', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.type({ label: 'Description' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(seen, { name: true, description: true })
  await view.unmount()
})

test('creating a store then pressing Back before the answer stays on home', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      'memoryStore.save': async (input: SaveInput<MemoryStoreForm>) => {
        calls.saves.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        update(nav, popView)
        return { ok: true, value: { id: 'memstore_new', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW_STORE })
  await view.type({ label: 'Name' }, 'plugin-test-store')
  await view.press({ role: 'button', text: 'Create' })
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Archive asks first, then archives and returns home with the list reread', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'Archive' })
  assert.ok(view.find({ type: 'Callout', text: /Archive Notes\? This can't be undone\./ }))
  assert.deepEqual(calls.archives, [])
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Archive' })
  assert.deepEqual(calls.archives, [{ kind: 'memory_store', id: 'memstore_a' }])
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.ok(calls.lists.length > listsBefore)
  await view.unmount()
})

test('Delete asks first, then deletes the store and returns home', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'Delete' })
  assert.ok(view.find({ type: 'Callout', text: /Delete Notes for good\? This can't be undone\./ }))
  assert.deepEqual(calls.deletes, [])
  await view.press({ role: 'button', text: 'Delete' })
  assert.deepEqual(calls.deletes, [{ kind: 'memory_store', id: 'memstore_a' }])
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  await view.unmount()
})

test('a delete refused by the API shows its text and keeps the store open', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), { 'resource.delete': { ok: false, code: 'other', error: 'The store is in use.' } })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'Delete' })
  await view.press({ role: 'button', text: 'Delete' })
  assert.equal(read(notice), 'The store is in use.')
  assert.deepEqual(view.persisted.plugin.nav, OPEN_STORE.plugin.nav)
  await view.unmount()
})

test('the home Memory tab offers New memory store, which opens the creation form', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: { plugin: { nav: [{ view: 'home' }], 'home.tab': 'memory_store' } } })
  await view.press({ role: 'button', text: 'New memory store' })
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'newConfig', kind: 'memory_store' }])
  assert.ok(view.find({ role: 'button', text: 'Create' }))
  await view.unmount()
})

// --- Banque : nouvelle mémoire ---

test('New memory asks for a path and shows the help text', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'New memory' })
  assert.ok(view.find({ text: 'Starts with /, for example /notes/today.md' }))
  assert.ok(view.find({ label: 'Path' }))
  assert.equal(view.find({ role: 'button', text: 'Edit content' }), null)
  await view.unmount()
})

test('a path refused by the memory path rule shows the rule and sends nothing', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'New memory' })
  const statesBefore = calls.states.length
  await view.type({ label: 'Path' }, '/notes/../today.md')
  assert.ok(view.find({ text: INVALID_MEMORY_PATH }))
  assert.equal(view.find({ role: 'button', text: 'Continue' })?.disabled, true)
  assert.equal(view.find({ role: 'button', text: 'Edit content' }), null)
  assert.equal(calls.states.length, statesBefore)
  await view.unmount()
})

test('a valid path renders the draft controls for a new memory and loads their state', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'New memory' })
  await view.type({ label: 'Path' }, '/notes/today.md')
  assert.equal(view.find({ text: INVALID_MEMORY_PATH }), null)
  await view.press({ role: 'button', text: 'Continue' })
  assert.ok(view.find({ role: 'button', text: 'Edit content' }))
  assert.deepEqual(calls.states.at(-1), { kind: 'memory', memoryStoreId: 'memstore_a', memoryId: null, path: '/notes/today.md' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Apply on a new memory rereads the store, so the memory appears in its list', async () => {
  const calls = newCalls()
  const world = newWorld()
  const info: DraftInfo = {
    ref: { kind: 'memory', memoryStoreId: 'memstore_a', memoryId: null, path: '/notes/today.md' },
    file: 'memories/notes--memstore_a/notes/today.md',
    unapplied: true,
    writtenAt: '2026-11-22T10:00:00Z',
    savedAt: '2026-11-22T10:42:00Z',
    returnTo: null
  }
  const host = mockHost({
    requests: requests(calls, world, {
      'draft.state': { ok: true, value: info },
      'draft.prepare': { ok: true, value: { ...PREPARED, creates: true } },
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        world.store = { ...STORE, memories: [...STORE.memories, { id: 'mem_new', path: '/notes/today.md', sizeBytes: 12, updatedAt: '2026-11-22T11:00:00Z' }] }
        return { ok: true, value: { label: 'Applied' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'New memory' })
  await view.type({ label: 'Path' }, '/notes/today.md')
  await view.press({ role: 'button', text: 'Continue' })
  assert.equal(view.find({ type: 'ListItem', label: '/notes/today.md' }), null)
  await view.press({ role: 'button', text: 'Apply' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(calls.commits.length, 1)
  assert.ok(view.find({ type: 'Callout', text: /Applied/ }))
  assert.ok(view.find({ type: 'ListItem', label: '/notes/today.md' }))
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  // « Done » ferme le succès ; la nouvelle mémoire est dans la liste, le bloc de saisie s'efface.
  await view.press({ role: 'button', text: 'Done' })
  assert.equal(view.find({ role: 'button', text: 'Edit content' }), null)
  assert.ok(view.find({ type: 'ListItem', label: '/notes/today.md' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

const NEW_INFO: DraftInfo = {
  ref: { kind: 'memory', memoryStoreId: 'memstore_a', memoryId: null, path: '/notes/today.md' },
  file: 'memories/notes--memstore_a/notes/today.md',
  unapplied: true,
  writtenAt: '2026-11-22T10:00:00Z',
  savedAt: '2026-11-22T10:42:00Z',
  returnTo: null
}

/** The fake worker knows an unapplied draft of the new memory `/notes/today.md`. */
function withNewDraft(calls: Calls, world: World, over: Record<string, unknown> = {}) {
  return requests(calls, world, {
    'draft.state': (input: DraftRef) => {
      calls.states.push(input)
      return { ok: true, value: input.kind === 'memory' && input.memoryId === null && input.path === '/notes/today.md' ? NEW_INFO : null }
    },
    ...over
  })
}

test('a new memory in progress survives a panel restart: the store shows its path with the draft controls', async () => {
  const calls = newCalls()
  const world = newWorld()
  const first = await mount(panel, { host: mockHost({ requests: withNewDraft(calls, world) }), persisted: OPEN_STORE })
  await first.press({ role: 'button', text: 'New memory' })
  await first.type({ label: 'Path' }, '/notes/today.md')
  await first.press({ role: 'button', text: 'Continue' })
  assert.ok(first.find({ role: 'button', text: 'Edit content' }))
  const kept = first.persisted.plugin
  await first.unmount()

  const again = newCalls()
  const second = await mount(panel, { host: mockHost({ requests: withNewDraft(again, world) }), persisted: { plugin: kept } })
  assert.ok(second.find({ type: 'Code', text: '/notes/today.md' }))
  assert.ok(second.find({ role: 'button', text: 'Edit content' }))
  // Les contrôles du brouillon ont lu leur état à l'ouverture : l'écriture non appliquée est proposée.
  assert.deepEqual(again.states.at(-1), { kind: 'memory', memoryStoreId: 'memstore_a', memoryId: null, path: '/notes/today.md' })
  assert.ok(second.find({ text: /Unapplied draft from/ }))
  assert.ok(second.find({ role: 'button', text: 'Apply' }))
  assert.deepEqual(second.errors, [])
  await second.unmount()
})

test('Discard on the draft of a new memory clears the pending entry, here and after a restart', async () => {
  const calls = newCalls()
  const world = newWorld()
  const view = await mount(panel, { host: mockHost({ requests: withNewDraft(calls, world) }), persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'New memory' })
  await view.type({ label: 'Path' }, '/notes/today.md')
  await view.press({ role: 'button', text: 'Continue' })
  await view.press({ role: 'button', text: 'Discard' })
  await view.press({ role: 'button', text: 'Discard' })
  assert.equal(view.find({ type: 'Code', text: '/notes/today.md' }), null)
  assert.ok(view.find({ role: 'button', text: 'New memory' }))
  assert.deepEqual(view.persisted.plugin['memory.new'], {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a pending entry whose memory now exists is dropped when the store opens', async () => {
  const world = newWorld()
  world.store = { ...STORE, memories: [...STORE.memories, { id: 'mem_new', path: '/notes/today.md', sizeBytes: 12, updatedAt: '2026-11-22T11:00:00Z' }] }
  const persisted = { plugin: { ...OPEN_STORE.plugin, 'memory.new': { memstore_a: { phase: 'editing', path: '/notes/today.md' } } } }
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls(), world) }), persisted })
  assert.ok(view.find({ type: 'ListItem', label: '/notes/today.md' }))
  assert.equal(view.find({ role: 'button', text: 'Edit content' }), null)
  assert.deepEqual(view.persisted.plugin['memory.new'], {})
  await view.unmount()
})

test('a path already used in the store is refused with its message, whatever the case, and sends nothing', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld()) }), persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'New memory' })
  const statesBefore = calls.states.length
  await view.type({ label: 'Path' }, '/Runbooks/Deploy.md')
  assert.ok(view.find({ text: 'A memory already has this path.' }))
  assert.equal(view.find({ role: 'button', text: 'Continue' })?.disabled, true)
  await view.type({ label: 'Path' }, '/runbooks/deploy.md', { replace: true })
  assert.ok(view.find({ text: 'A memory already has this path.' }))
  assert.equal(view.find({ role: 'button', text: 'Edit content' }), null)
  assert.equal(calls.states.length, statesBefore)
  // Un autre chemin lève l'avis.
  await view.type({ label: 'Path' }, '/runbooks/other.md', { replace: true })
  assert.equal(view.find({ text: 'A memory already has this path.' }), null)
  assert.equal(view.find({ role: 'button', text: 'Continue' })?.disabled, false)
  await view.unmount()
})

// --- Mémoire ---

test('a memory deleted while Back is pressed does not stay in the store list', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      'resource.delete': async (input: unknown) => {
        calls.deletes.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        // Un `await` plus tard, la personne a appuyé sur Back : la banque est au sommet, son détail chargé est périmé.
        update(nav, popView)
        world.store = { ...STORE, memories: [STORE.memories[1]!] }
        return { ok: true, value: null }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ type: 'ListItem', label: '/runbooks/deploy.md' })
  await view.press({ role: 'button', text: 'Delete' })
  await view.press({ role: 'button', text: 'Delete' })
  assert.deepEqual(view.persisted.plugin.nav, OPEN_STORE.plugin.nav)
  assert.equal(view.find({ type: 'ListItem', label: '/runbooks/deploy.md' }), null)
  assert.ok(view.find({ type: 'ListItem', label: '/runbooks/rollback.md' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a memory offers Edit content once, a Path field with Rename, and Delete', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  assert.equal(view.findAll({ role: 'button', text: 'Edit content' }).length, 1)
  assert.equal(view.valueOf({ label: 'Path' }), '/runbooks/deploy.md')
  assert.equal(view.find({ role: 'button', text: 'Rename' })?.disabled, true)
  assert.ok(view.find({ role: 'button', text: 'Delete' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Rename sends the new path with the sha256 the panel read, then shows the new path', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({ requests: requests(calls, world) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  assert.equal(view.find({ role: 'button', text: 'Rename' })?.disabled, false)
  await view.press({ role: 'button', text: 'Rename' })
  assert.deepEqual(calls.renames, [{ memoryStoreId: 'memstore_a', memoryId: 'mem_a', path: '/runbooks/ship.md', baseSha256: 'sha-one' }])
  // La mémoire est relue : le nouveau chemin et le nouveau sha256 remplacent les anciens.
  assert.equal(calls.reads.length, 2)
  assert.equal(view.valueOf({ label: 'Path' }), '/runbooks/ship.md')
  assert.equal(view.find({ role: 'button', text: 'Rename' })?.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('after a rename, going back shows the store reread with its new list', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      'memory.rename': (input: MemoryRenameInput) => {
        calls.renames.push(input)
        world.memory = { ...world.memory, path: input.path, sha256: 'sha-two' }
        world.store = { ...STORE, memories: [{ ...STORE.memories[0]!, path: input.path }, STORE.memories[1]!] }
        return { ok: true, value: { id: input.memoryId, updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  // La banque est chargée d'abord : sa liste en mémoire doit être déclarée périmée par le renommage.
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ type: 'ListItem', label: '/runbooks/deploy.md' })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  await view.press({ role: 'button', text: 'Rename' })
  await view.press({ role: 'button', text: /Back/ })
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  assert.ok(view.find({ type: 'ListItem', label: '/runbooks/ship.md' }))
  assert.equal(view.find({ type: 'ListItem', label: '/runbooks/deploy.md' }), null)
  await view.unmount()
})

test('a path refused by the memory path rule shows the rule and keeps Rename disabled', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.type({ label: 'Path' }, 'runbooks/ship.md', { replace: true })
  assert.ok(view.find({ text: INVALID_MEMORY_PATH }))
  assert.equal(view.find({ role: 'button', text: 'Rename' })?.disabled, true)
  assert.deepEqual(calls.renames, [])
  await view.unmount()
})

test('a rename refused because of an open draft shows the reason and keeps the typed path', async () => {
  const calls = newCalls()
  const reason = 'Apply or discard the open draft of this memory first.'
  const host = mockHost({ requests: requests(calls, newWorld(), { 'memory.rename': { ok: false, code: 'other', error: reason } }) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  await view.press({ role: 'button', text: 'Rename' })
  assert.ok(view.find({ type: 'Callout', text: /Could not rename/ }))
  assert.ok(view.find({ text: reason }))
  assert.equal(view.valueOf({ label: 'Path' }), '/runbooks/ship.md')
  await view.unmount()
})

test('a rename on changed content offers Reload, which rereads the memory and drops the typed path', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld(), { 'memory.rename': CONFLICT }) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  await view.press({ role: 'button', text: 'Rename' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Reload' })
  assert.equal(calls.reads.length, 2)
  assert.equal(view.valueOf({ label: 'Path' }), '/runbooks/deploy.md')
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  await view.unmount()
})

test('Delete asks first, then deletes the memory and returns to the store reread', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      'resource.delete': (input: unknown) => {
        calls.deletes.push(input)
        world.store = { ...STORE, memories: [STORE.memories[1]!] }
        return { ok: true, value: null }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Delete' })
  assert.ok(view.find({ type: 'Callout', text: /Delete \/runbooks\/deploy\.md for good\? This can't be undone\./ }))
  assert.deepEqual(calls.deletes, [])
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Delete' })
  assert.deepEqual(calls.deletes, [{ kind: 'memory', memoryStoreId: 'memstore_a', id: 'mem_a' }])
  assert.deepEqual(view.persisted.plugin.nav, OPEN_STORE.plugin.nav)
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['memstore_a'])
  assert.ok(view.find({ type: 'ListItem', label: '/runbooks/rollback.md' }))
  assert.equal(view.find({ type: 'ListItem', label: '/runbooks/deploy.md' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Apply on an existing memory rereads it, and the view shows the new content', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        world.memory = { ...world.memory, sha256: 'sha-three', content: { text: '# Deploy\n\nRun the NEW script.', truncated: false } }
        return { ok: true, value: { label: 'Applied' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ type: 'ListItem', label: '/runbooks/deploy.md' })
  assert.equal(view.find({ type: 'Markdown' })?.props.content, '# Deploy\n\nRun the script.')
  assert.equal(calls.reads.length, 1)
  await view.press({ role: 'button', text: 'Apply' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(calls.commits.length, 1)
  assert.ok(view.find({ type: 'Callout', text: /Applied/ }))
  assert.equal(calls.reads.length, 2)
  assert.equal(view.find({ type: 'Markdown' })?.props.content, '# Deploy\n\nRun the NEW script.')
  // La banque est périmée (taille, date) : Back la relit.
  await view.press({ role: 'button', text: /Back/ })
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

// --- Gate 3 ---

test('the actions of a memory are drawn above its content, so a long content never pushes them away', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld()) }), persisted: OPEN_MEMORY })
  const drawn = JSON.stringify(view.tree())
  const actions = drawn.indexOf('Edit content')
  const content = drawn.indexOf('Run the script.')
  assert.ok(actions >= 0 && content >= 0)
  assert.ok(actions < content)
  await view.unmount()
})

test('Close of a new memory is hidden while its draft is unapplied, and shown once it is not', async () => {
  const calls = newCalls()
  const world = newWorld()
  const view = await mount(panel, { host: mockHost({ requests: withNewDraft(calls, world) }), persisted: OPEN_STORE })
  await view.press({ role: 'button', text: 'New memory' })
  await view.type({ label: 'Path' }, '/notes/today.md')
  await view.press({ role: 'button', text: 'Continue' })
  assert.ok(view.find({ text: /Unapplied draft from/ }))
  assert.equal(view.find({ role: 'button', text: 'Close' }), null)
  // Discard reste la sortie.
  assert.ok(view.find({ role: 'button', text: 'Discard' }))
  await view.unmount()

  const clean = await mount(panel, {
    host: mockHost({ requests: withNewDraft(newCalls(), world, { 'draft.state': { ok: true, value: { ...NEW_INFO, unapplied: false } } }) }),
    persisted: OPEN_STORE
  })
  await clean.press({ role: 'button', text: 'New memory' })
  await clean.type({ label: 'Path' }, '/notes/today.md')
  await clean.press({ role: 'button', text: 'Continue' })
  assert.ok(clean.find({ role: 'button', text: 'Close' }))
  await clean.unmount()
})

test('Delete of a memory with an unapplied draft says the draft stays as a new memory at that path', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld()) }), persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Delete' })
  assert.ok(view.find({ type: 'Callout', text: /Delete \/runbooks\/deploy\.md for good\? This can't be undone\. Your unapplied draft stays as a new memory at this path\./ }))
  await view.unmount()
})

test('Delete of a memory without an unapplied draft keeps the plain question', async () => {
  const calls = newCalls()
  const clean = { 'draft.state': { ok: true, value: { ref: { kind: 'memory', memoryStoreId: 'memstore_a', memoryId: 'mem_a', path: '/runbooks/deploy.md' }, file: 'f', unapplied: false, writtenAt: '2026-11-22T10:00:00Z', savedAt: '2026-11-22T10:00:00Z', returnTo: null } } }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), clean) }), persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Delete' })
  assert.ok(view.find({ type: 'Callout', text: /Delete \/runbooks\/deploy\.md for good\? This can't be undone\./ }))
  assert.equal(view.find({ text: /Your unapplied draft/ }), null)
  await view.unmount()
})

test('Discard on the draft of an existing memory rereads the memory', async () => {
  const calls = newCalls()
  const world = newWorld()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, world) }), persisted: OPEN_MEMORY })
  assert.equal(calls.reads.length, 1)
  world.memory = { ...world.memory, sha256: 'sha-three', content: { text: '# Deploy\n\nChanged elsewhere.', truncated: false } }
  await view.press({ role: 'button', text: 'Discard' })
  await view.press({ role: 'button', text: 'Discard' })
  assert.equal(calls.reads.length, 2)
  assert.equal(view.find({ type: 'Markdown' })?.props.content, '# Deploy\n\nChanged elsewhere.')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Reload after a conflict on an existing memory rereads the memory', async () => {
  const calls = newCalls()
  const world = newWorld()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, world, { 'write.commit': CONFLICT }) }), persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Apply' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  world.memory = { ...world.memory, sha256: 'sha-three', content: { text: '# Deploy\n\nChanged elsewhere.', truncated: false } }
  await view.press({ role: 'button', text: 'Reload' })
  assert.equal(calls.reads.length, 2)
  assert.equal(view.find({ type: 'Markdown' })?.props.content, '# Deploy\n\nChanged elsewhere.')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
