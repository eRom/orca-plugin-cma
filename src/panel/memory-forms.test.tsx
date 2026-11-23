import { read, update } from 'orca'
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import type {
  ConfigKind,
  ConfigRow,
  DraftInfo,
  DraftRef,
  MemoryContent,
  MemoryRenameInput,
  MemoryStoreDetail,
  MemoryStoreForm,
  SaveInput,
  UploadItem
} from '../protocol'
import * as panel from '../panel'
import { INVALID_MEMORY_PATH } from '../shared/memory-path'
import { formDrafts } from './form-state'
import { nav, notice, popView } from './state'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }]
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
  stages: { memoryStoreId: string; items: UploadItem[] }[]
  opens: DraftRef[]
}

function newCalls(): Calls {
  return { saves: [], lists: [], details: [], reads: [], renames: [], archives: [], deletes: [], states: [], commits: [], stages: [], opens: [] }
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
    'file.pick': { ok: true, value: null },
    'memory.stageUploads': (input: { memoryStoreId: string; items: UploadItem[] }) => {
      calls.stages.push(input)
      return { ok: true, value: { ...PREPARED, creates: true } }
    },
    'draft.open': (input: DraftRef) => {
      calls.opens.push(input)
      return { ok: true, value: { ...info, ref: input } }
    },
    ...over
  } as never
}

type View = Awaited<ReturnType<typeof mount>>

/** Presse le dernier bouton de ce texte : la question de confirmation s'ouvre après le bouton du geste. */
async function pressConfirm(view: View, text: string): Promise<void> {
  const last = view.findAll({ role: 'button', text }).at(-1)
  assert.ok(last, `no ${text} button`)
  await view.press(last)
}

/** Vrai quand la banque montre la ligne de cette mémoire (son bouton « Open »). */
function hasMemory(view: View, path: string): boolean {
  return view.find({ role: 'button', label: `Open ${path}` }) !== null
}

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
  assert.ok(view.find({ type: 'Callout', text: /The name is too long\./ }))
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
  await pressConfirm(view, 'Archive')
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
  await pressConfirm(view, 'Delete')
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
  await pressConfirm(view, 'Delete')
  assert.equal(read(notice), 'The store is in use.')
  assert.deepEqual(view.persisted.plugin.nav, OPEN_STORE.plugin.nav)
  await view.unmount()
})

test('the home Memory tab offers New memory store, which opens the creation form', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: { plugin: { nav: [{ view: 'home' }], 'home.tab': 'memory_store' } } })
  await view.press({ type: 'IconButton', label: 'New memory store' })
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'newConfig', kind: 'memory_store' }])
  assert.ok(view.find({ role: 'button', text: 'Create' }))
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
  await view.press({ role: 'button', label: 'Open /runbooks/deploy.md' })
  await view.press({ role: 'button', text: 'Delete' })
  await pressConfirm(view, 'Delete')
  assert.deepEqual(view.persisted.plugin.nav, OPEN_STORE.plugin.nav)
  assert.equal(hasMemory(view, '/runbooks/deploy.md'), false)
  assert.ok(hasMemory(view, '/runbooks/rollback.md'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a memory offers its four actions, and Rename opens its Path field below', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  for (const text of ['Edit in editor', 'Replace…', 'Rename', 'Delete']) {
    assert.equal(view.findAll({ role: 'button', text }).length, 1, text)
  }
  // Rien d'autre qu'un bouton d'action : ni champ ni bouton de renommage tant que Rename n'est pas pressé.
  assert.equal(view.find({ label: 'Path' }), null)
  assert.equal(view.find({ role: 'button', text: 'Save path' }), null)
  await view.press({ role: 'button', text: 'Rename' })
  assert.equal(view.valueOf({ label: 'Path' }), '/runbooks/deploy.md')
  assert.equal(view.find({ role: 'button', text: 'Save path' })?.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Rename sends the new path with the sha256 the panel read, then shows the new path', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({ requests: requests(calls, world) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Rename' })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  assert.equal(view.find({ role: 'button', text: 'Save path' })?.disabled, false)
  await view.press({ role: 'button', text: 'Save path' })
  assert.deepEqual(calls.renames, [{ memoryStoreId: 'memstore_a', memoryId: 'mem_a', path: '/runbooks/ship.md', baseSha256: 'sha-one' }])
  // La mémoire est relue : le nouveau chemin et le nouveau sha256 remplacent les anciens, le champ se referme.
  assert.equal(calls.reads.length, 2)
  assert.equal(view.find({ label: 'Path' }), null)
  assert.ok(view.find({ text: '/runbooks/ship.md' }))
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
  await view.press({ role: 'button', label: 'Open /runbooks/deploy.md' })
  await view.press({ role: 'button', text: 'Rename' })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  await view.press({ role: 'button', text: 'Save path' })
  await view.press({ role: 'button', text: /Back/ })
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  assert.ok(hasMemory(view, '/runbooks/ship.md'))
  assert.equal(hasMemory(view, '/runbooks/deploy.md'), false)
  await view.unmount()
})

test('a path refused by the memory path rule shows the rule and keeps Rename disabled', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld()) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Rename' })
  await view.type({ label: 'Path' }, 'runbooks/ship.md', { replace: true })
  assert.ok(view.find({ text: INVALID_MEMORY_PATH }))
  assert.equal(view.find({ role: 'button', text: 'Save path' })?.disabled, true)
  assert.deepEqual(calls.renames, [])
  await view.unmount()
})

test('a rename refused because of an open draft shows the reason and keeps the typed path', async () => {
  const calls = newCalls()
  const reason = 'Apply or discard the open draft of this memory first.'
  const host = mockHost({ requests: requests(calls, newWorld(), { 'memory.rename': { ok: false, code: 'other', error: reason } }) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Rename' })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  await view.press({ role: 'button', text: 'Save path' })
  assert.ok(view.find({ type: 'Callout', text: /Could not rename/ }))
  assert.ok(view.find({ text: reason }))
  assert.equal(view.valueOf({ label: 'Path' }), '/runbooks/ship.md')
  await view.unmount()
})

test('a rename on changed content offers Reload, which rereads the memory and drops the typed path', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld(), { 'memory.rename': CONFLICT }) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Rename' })
  await view.type({ label: 'Path' }, '/runbooks/ship.md', { replace: true })
  await view.press({ role: 'button', text: 'Save path' })
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
  await pressConfirm(view, 'Delete')
  assert.deepEqual(calls.deletes, [{ kind: 'memory', memoryStoreId: 'memstore_a', id: 'mem_a' }])
  assert.deepEqual(view.persisted.plugin.nav, OPEN_STORE.plugin.nav)
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['memstore_a'])
  assert.ok(hasMemory(view, '/runbooks/rollback.md'))
  assert.equal(hasMemory(view, '/runbooks/deploy.md'), false)
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
  await view.press({ role: 'button', label: 'Open /runbooks/deploy.md' })
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
  const actions = drawn.indexOf('Edit in editor')
  const content = drawn.indexOf('Run the script.')
  assert.ok(actions >= 0 && content >= 0)
  assert.ok(actions < content)
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

// --- Envoi de fichiers ---

const TODAY = { file: '/Users/someone/notes/today.md', name: 'today.md' }
const TODO = { file: '/Users/someone/notes/todo.md', name: 'todo.md' }
/** Aucun brouillon connu : l'écran de la banque ne montre que ses lignes d'envoi. */
const NO_DRAFT = { 'draft.state': { ok: true, value: null } }
const PATH_TAKEN = 'A memory already has this path.'
const NOT_TEXT = 'This file is not text: memories hold UTF-8 text.'

/** Un faux `file.pick` qui rend ces fichiers dans l'ordre, puis `null` (boîte annulée). */
function picks(files: { file: string; name: string }[]) {
  let next = 0
  return () => ({ ok: true, value: files[next++] ?? null })
}

const pathFields = (view: View) => view.findAll({ label: 'Memory path' })
const fileButtons = (view: View) => view.findAll({ role: 'button' }).filter((button) => button.props.icon === 'file')

async function addRows(view: View, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await view.press({ role: 'button', text: 'Add' })
}

/** Remplit la ligne `index` : son chemin, puis le fichier que le faux `file.pick` rend. */
async function fillRow(view: View, index: number, path: string, pick = true): Promise<void> {
  const field = pathFields(view)[index]
  assert.ok(field, `no row ${index}`)
  await view.type(field, path)
  if (pick) {
    const button = fileButtons(view)[index]
    assert.ok(button, `no file button ${index}`)
    await view.press(button)
  }
}

const SAVED_ROW = { id: 'r1', path: '/notes/today.md', file: TODAY.file, name: TODAY.name, memoryId: null }
const withRows = (rows: unknown[]) => ({ plugin: { ...OPEN_STORE.plugin, 'memory.uploads': { memstore_a: rows } } })

test('two rows with a chosen file are staged in one call, previewed, confirmed, then removed and the store reread', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      ...NO_DRAFT,
      'file.pick': picks([TODAY, TODO]),
      'memory.stageUploads': (input: { memoryStoreId: string; items: UploadItem[] }) => {
        calls.stages.push(input)
        const changes = input.items.map((item) => ({ path: item.path, before: null, after: 'x', lines: { added: 1, removed: 0 } }))
        return { ok: true, value: { ...PREPARED, creates: true, changes, totalChanges: 2 } }
      },
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        world.store = {
          ...STORE,
          memories: [
            ...STORE.memories,
            { id: 'mem_c', path: '/notes/today.md', sizeBytes: 12, updatedAt: '2026-11-22T11:00:00Z' },
            { id: 'mem_d', path: '/notes/todo.md', sizeBytes: 9, updatedAt: '2026-11-22T11:00:00Z' }
          ]
        }
        return { ok: true, value: { label: 'Uploaded 2 memories' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await addRows(view, 2)
  assert.equal(view.find({ role: 'button', text: 'Apply (0)' })?.disabled, true)
  await fillRow(view, 0, '/notes/today.md')
  await fillRow(view, 1, '/notes/todo.md')
  assert.equal(fileButtons(view)[0]?.text, 'today.md')
  assert.equal(view.find({ role: 'button', text: 'Apply (2)' })?.disabled, false)
  assert.deepEqual(calls.stages, [])
  await view.press({ role: 'button', text: 'Apply (2)' })
  assert.deepEqual(calls.stages, [
    {
      memoryStoreId: 'memstore_a',
      items: [
        { path: '/notes/today.md', file: TODAY.file, memoryId: null },
        { path: '/notes/todo.md', file: TODO.file, memoryId: null }
      ]
    }
  ])
  // Pendant le récapitulatif, Apply laisse la place à Confirm et Cancel ; les lignes ne bougent plus.
  assert.ok(view.find({ text: 'Review changes' }))
  assert.equal(view.find({ role: 'button', text: 'Apply (2)' }), null)
  assert.equal(pathFields(view)[0]?.disabled, true)
  assert.deepEqual(calls.commits, [])
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Confirm' })
  assert.deepEqual(calls.commits, [{ token: PREPARED.token, force: false }])
  assert.ok(view.find({ type: 'Callout', text: /Uploaded 2 memories/ }))
  assert.deepEqual(view.persisted.plugin['memory.uploads'], {})
  assert.equal(pathFields(view).length, 0)
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  assert.ok(hasMemory(view, '/notes/today.md'))
  assert.ok(hasMemory(view, '/notes/todo.md'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a file dialog that does not answer in time says so under its row, and the next press waits for it again', async () => {
  const calls = newCalls()
  let pickCalls = 0
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      ...NO_DRAFT,
      // Le premier appui expire (la boîte reste ouverte côté worker) ; le second rejoint cette boîte et reçoit son choix.
      'file.pick': () => {
        pickCalls += 1
        if (pickCalls === 1) throw hostError('timeout', 'The worker took too long')
        return { ok: true, value: TODAY }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await addRows(view, 1)
  await view.press(fileButtons(view)[0]!)
  assert.ok(view.find({ text: 'The file dialog is still open. Press the button again to wait for your choice.' }))
  assert.equal(read(notice), null)
  // La ligne reste utilisable : un nouvel appui relance la demande, et le choix arrive.
  assert.equal(fileButtons(view)[0]?.disabled, false)
  await view.press(fileButtons(view)[0]!)
  assert.equal(pickCalls, 2)
  assert.equal(fileButtons(view)[0]?.text, 'today.md')
  assert.equal(view.find({ text: /still open/ }), null)
  await view.unmount()
})

test('the file dialog waits as long as Orca allows, and a cancelled dialog changes nothing', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld(), NO_DRAFT) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await addRows(view, 1)
  await view.press(fileButtons(view)[0]!)
  const pickCall = host.calls.find((call) => call.method === 'plugin.request' && (call.params as { name?: string }).name === 'file.pick')
  assert.equal((pickCall?.params as { timeoutMs?: number }).timeoutMs, 120_000)
  assert.equal(fileButtons(view)[0]?.text, 'Choose file…')
  assert.equal(pathFields(view).length, 1)
  assert.deepEqual((view.persisted.plugin['memory.uploads'] as Record<string, { file: string }[]>).memstore_a?.map((row) => row.file), [''])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a file picker refusal shows under its row and does not block the others', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), { ...NO_DRAFT, 'file.pick': { ok: false, code: 'other', error: 'File picking works on macOS only.' } })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await addRows(view, 1)
  await view.press(fileButtons(view)[0]!)
  assert.ok(view.find({ text: 'File picking works on macOS only.' }))
  assert.equal(fileButtons(view)[0]?.text, 'Choose file…')
  await view.unmount()
})

test('an invalid path, a path taken in the store whatever the case, and a repeated path show their message and block Apply', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld(), { ...NO_DRAFT, 'file.pick': picks([TODAY, TODO, TODAY]) }) })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await addRows(view, 3)
  await fillRow(view, 0, 'runbooks/ship.md')
  assert.ok(view.find({ text: INVALID_MEMORY_PATH }))
  assert.equal(view.find({ role: 'button', text: 'Apply (0)' })?.disabled, true)
  assert.equal(pathFields(view)[0]?.props.invalid, true)

  await view.type(pathFields(view)[0]!, '/Runbooks/Deploy.md', { replace: true })
  assert.equal(view.find({ text: INVALID_MEMORY_PATH }), null)
  assert.ok(view.find({ text: PATH_TAKEN }))

  await view.type(pathFields(view)[0]!, '/notes/a.md', { replace: true })
  assert.equal(view.find({ text: PATH_TAKEN }), null)
  await fillRow(view, 1, '/notes/A.md')
  await fillRow(view, 2, '/notes/b.md')
  // La deuxième ligne répète le chemin de la première (casse comprise) : seule elle porte l'avis.
  assert.equal(view.findAll({ text: PATH_TAKEN }).length, 1)
  assert.equal(view.find({ role: 'button', text: 'Apply (2)' })?.disabled, true)

  await view.type(pathFields(view)[1]!, '/notes/c.md', { replace: true })
  assert.equal(view.find({ text: PATH_TAKEN }), null)
  assert.equal(view.find({ role: 'button', text: 'Apply (3)' })?.disabled, false)
  assert.deepEqual(calls.stages, [])
  await view.unmount()
})

test('a row without a file keeps Apply disabled', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), NO_DRAFT) }), persisted: OPEN_STORE })
  await addRows(view, 1)
  await fillRow(view, 0, '/notes/today.md', false)
  assert.equal(view.find({ role: 'button', text: 'Apply (0)' })?.disabled, true)
  assert.deepEqual(calls.stages, [])
  await view.unmount()
})

test('a refused file is shown with the worker text, nothing is previewed and the rows stay', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), { ...NO_DRAFT, 'memory.stageUploads': { ok: false, code: 'invalid', error: NOT_TEXT } })
  })
  const view = await mount(panel, { host, persisted: withRows([SAVED_ROW]) })
  await view.press({ role: 'button', text: 'Apply (1)' })
  assert.ok(view.find({ type: 'Callout', text: /Not uploaded/ }))
  assert.ok(view.find({ text: NOT_TEXT }))
  assert.equal(view.find({ text: 'Review changes' }), null)
  assert.equal(pathFields(view).length, 1)
  assert.equal(view.find({ role: 'button', text: 'Apply (1)' })?.disabled, false)
  await view.unmount()
})

test('a refusal of another kind is a danger notice with its title', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), { ...NO_DRAFT, 'memory.stageUploads': { ok: false, code: 'other', error: 'API error 500: boom' } })
  })
  const view = await mount(panel, { host, persisted: withRows([SAVED_ROW]) })
  await view.press({ role: 'button', text: 'Apply (1)' })
  assert.ok(view.find({ type: 'Callout', text: /Could not upload/ }))
  assert.ok(view.find({ text: 'API error 500: boom' }))
  await view.unmount()
})

test('the rows come back after a restart with their path and file, and no file content is ever persisted', async () => {
  const calls = newCalls()
  const secret = 'SENTINEL-FILE-CONTENT-quokka'
  const host = () =>
    mockHost({
      requests: requests(calls, newWorld(), {
        ...NO_DRAFT,
        'file.pick': picks([TODAY]),
        'memory.stageUploads': { ok: true, value: { ...PREPARED, creates: true, changes: [{ path: '/notes/today.md', before: null, after: secret, lines: null }] } }
      })
    })
  const first = await mount(panel, { host: host(), persisted: OPEN_STORE })
  await addRows(first, 1)
  await fillRow(first, 0, '/notes/today.md')
  // Le récapitulatif montre un contenu (le faux worker le met dans l'aperçu) : il ne doit pas sortir de la mémoire du panneau.
  await first.press({ role: 'button', text: 'Apply (1)' })
  assert.ok(first.find({ text: new RegExp(secret) }))
  const kept = first.persisted.plugin
  assert.equal(JSON.stringify(first.persisted).includes(secret), false)
  const rows = (kept['memory.uploads'] as Record<string, { id: string }[]>).memstore_a
  assert.equal(rows?.length, 1)
  assert.deepEqual(Object.keys(rows?.[0] ?? {}).sort(), ['file', 'id', 'memoryId', 'name', 'path'])
  await first.unmount()

  const second = await mount(panel, { host: host(), persisted: { plugin: kept } })
  assert.equal(second.valueOf(pathFields(second)[0]!), '/notes/today.md')
  assert.equal(fileButtons(second)[0]?.text, 'today.md')
  assert.equal(fileButtons(second)[0]?.props.tooltip, TODAY.file)
  assert.equal(second.find({ role: 'button', text: 'Apply (1)' })?.disabled, false)
  assert.equal(JSON.stringify(second.persisted).includes(secret), false)
  await second.unmount()
})

test('a long file name is cut in the button and kept whole in its tooltip', async () => {
  const calls = newCalls()
  const name = `${'long-'.repeat(20)}name.md`
  const row = { ...SAVED_ROW, file: `/Users/someone/${name}`, name }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), NO_DRAFT) }), persisted: withRows([row]) })
  const button = fileButtons(view)[0]
  assert.ok(button)
  assert.ok(button.text.length < name.length)
  // Coupé par le milieu : le début et l'extension restent lisibles.
  assert.equal(button.text, 'long-…name.md')
  assert.equal(button.props.tooltip, row.file)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Remove drops its row only', async () => {
  const calls = newCalls()
  const rows = [SAVED_ROW, { ...SAVED_ROW, id: 'r2', path: '/notes/todo.md', file: TODO.file, name: TODO.name }]
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), NO_DRAFT) }), persisted: withRows(rows) })
  await view.press(view.findAll({ role: 'button', label: 'Remove' })[0]!)
  assert.equal(pathFields(view).length, 1)
  assert.equal(view.valueOf(pathFields(view)[0]!), '/notes/todo.md')
  await view.press({ role: 'button', label: 'Remove' })
  assert.deepEqual(view.persisted.plugin['memory.uploads'], {})
  await view.unmount()
})

test('an empty store says so, offers no Apply, and an empty upload list says how to start', async () => {
  const calls = newCalls()
  const world = newWorld()
  world.store = { ...STORE, memories: [] }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, world, NO_DRAFT) }), persisted: OPEN_STORE })
  assert.ok(view.find({ text: 'No memories yet.' }))
  assert.ok(view.find({ text: 'Add a row, give it a memory path and choose a file.' }))
  assert.equal(view.findAll({ role: 'button', text: /^Apply/ }).length, 0)
  await view.unmount()
})

// --- Remplacer une mémoire ---

test('Replace… on a memory adds a row filled with its path and id, back on the store', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld(), NO_DRAFT) })
  const view = await mount(panel, { host, persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Replace…' })
  assert.deepEqual(view.persisted.plugin.nav, OPEN_STORE.plugin.nav)
  const saved = (view.persisted.plugin['memory.uploads'] as Record<string, { path: string; file: string; memoryId: string | null }[]>).memstore_a
  assert.equal(saved?.length, 1)
  assert.equal(saved?.[0]?.path, '/runbooks/deploy.md')
  assert.equal(saved?.[0]?.memoryId, 'mem_a')
  assert.equal(saved?.[0]?.file, '')
  // Le chemin d'une mémoire remplacée ne se tape plus : la ligne ne peut pas la renommer.
  assert.equal(pathFields(view)[0]?.props.value, '/runbooks/deploy.md')
  assert.equal(pathFields(view)[0]?.disabled, true)
  assert.ok(view.find({ text: 'Replaces the content of this memory.' }))
  assert.equal(view.find({ role: 'button', text: 'Apply (0)' })?.disabled, true)
  // Une seconde demande pour la même mémoire ne double pas la ligne.
  await view.press({ role: 'button', label: 'Open /runbooks/deploy.md' })
  await view.press({ role: 'button', text: 'Replace…' })
  assert.equal(pathFields(view).length, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

const REPLACE_ROW = { id: 'r1', path: '/runbooks/deploy.md', file: TODAY.file, name: TODAY.name, memoryId: 'mem_a' }

test('a replacement refused as changed elsewhere offers Reload, which keeps the rows and rereads the store', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      ...NO_DRAFT,
      'memory.stageUploads': (input: { memoryStoreId: string; items: UploadItem[] }) => {
        calls.stages.push(input)
        return { ok: true, value: { ...PREPARED, creates: false } }
      },
      'write.commit': CONFLICT
    })
  })
  const view = await mount(panel, { host, persisted: withRows([REPLACE_ROW]) })
  await view.press({ role: 'button', text: 'Apply (1)' })
  assert.deepEqual(calls.stages[0]?.items, [{ path: '/runbooks/deploy.md', file: TODAY.file, memoryId: 'mem_a' }])
  await view.press({ role: 'button', text: 'Confirm' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  assert.ok(view.find({ role: 'button', text: 'Apply anyway' }))
  const detailsBefore = calls.details.length
  await view.press({ role: 'button', text: 'Reload' })
  assert.equal(calls.details.length, detailsBefore + 1)
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.equal(pathFields(view).length, 1)
  assert.equal(view.find({ role: 'button', text: 'Apply (1)' })?.disabled, false)
  await view.unmount()
})

test('Apply anyway sends the same token with force and then removes the row', async () => {
  const calls = newCalls()
  let answers = 0
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      ...NO_DRAFT,
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        answers += 1
        return answers === 1 ? CONFLICT : { ok: true, value: { label: 'Uploaded 1 memory' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: withRows([REPLACE_ROW]) })
  await view.press({ role: 'button', text: 'Apply (1)' })
  await view.press({ role: 'button', text: 'Confirm' })
  await view.press({ role: 'button', text: 'Apply anyway' })
  assert.deepEqual(calls.commits, [
    { token: PREPARED.token, force: false },
    { token: PREPARED.token, force: true }
  ])
  assert.ok(view.find({ type: 'Callout', text: /Uploaded 1 memory/ }))
  assert.deepEqual(view.persisted.plugin['memory.uploads'], {})
  await view.unmount()
})

// --- Envoi interrompu ---

const NEW_A = { ...SAVED_ROW, id: 'r2', path: '/notes/a.md' }
const NEW_B = { ...SAVED_ROW, id: 'r3', path: '/notes/b.md' }

test('a partial failure rereads the store and drops the created rows, keeps the pending ones and the replacement', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      ...NO_DRAFT,
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        // La première ligne (la création de /notes/A.md, casse différente) est passée avant l'échec.
        world.store = { ...STORE, memories: [...STORE.memories, { id: 'mem_n', path: '/notes/A.md', sizeBytes: 3, updatedAt: '2026-11-22T11:00:00Z' }] }
        return { ok: false, code: 'other', error: 'Uploaded 1 of 3. API error 500: boom' }
      }
    })
  })
  const view = await mount(panel, { host, persisted: withRows([REPLACE_ROW, NEW_A, NEW_B]) })
  await view.press({ role: 'button', text: 'Apply (3)' })
  const listsBefore = calls.lists.length
  const detailsBefore = calls.details.length
  await view.press({ role: 'button', text: 'Confirm' })
  assert.ok(view.find({ type: 'Callout', text: /Could not upload/ }))
  assert.ok(view.find({ text: 'Uploaded 1 of 3. API error 500: boom' }))
  assert.ok(calls.lists.length > listsBefore)
  assert.equal(calls.details.length, detailsBefore + 1)
  const left = (view.persisted.plugin['memory.uploads'] as Record<string, { id: string; path: string; memoryId: string | null }[]>).memstore_a
  assert.deepEqual(left?.map((row) => row.id), ['r1', 'r3'])
  assert.ok(hasMemory(view, '/notes/A.md'))
  // Le récapitulatif reste ouvert : un second Confirm reprend avec le même jeton.
  assert.ok(view.find({ role: 'button', text: 'Confirm' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a lost token rereads the store, drops the rows whose path now exists and keeps the replacement', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      ...NO_DRAFT,
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        world.store = { ...STORE, memories: [...STORE.memories, { id: 'mem_n', path: '/notes/a.md', sizeBytes: 3, updatedAt: '2026-11-22T11:00:00Z' }] }
        return { ok: false, code: 'expired', error: 'This review expired: press Apply again.' }
      }
    })
  })
  const view = await mount(panel, { host, persisted: withRows([REPLACE_ROW, NEW_A, NEW_B]) })
  await view.press({ role: 'button', text: 'Apply (3)' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.ok(view.find({ type: 'Callout', text: /Not uploaded/ }))
  assert.ok(view.find({ text: 'This review expired: press Apply again.' }))
  const left = (view.persisted.plugin['memory.uploads'] as Record<string, { id: string }[]>).memstore_a
  assert.deepEqual(left?.map((row) => row.id), ['r1', 'r3'])
  assert.equal(view.find({ text: 'Review changes' }), null)
  assert.equal(view.find({ role: 'button', text: 'Apply (2)' })?.disabled, false)
  await view.unmount()
})

// --- Éditeur depuis la liste ---

const OPENED_INFO = (ref: DraftRef): DraftInfo => ({
  ref,
  file: 'memories/notes--memstore_a/runbooks/deploy.md',
  unapplied: false,
  writtenAt: '2026-11-22T10:00:00Z',
  savedAt: '2026-11-22T10:00:00Z',
  returnTo: null
})

test('the edit icon of a row opens the draft in the editor, and Apply lives in the memory detail only', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      ...NO_DRAFT,
      // Le worker vient d'écrire le fichier : il n'a pas encore été modifié, le brouillon n'est « ouvert » que depuis ce panneau.
      'draft.open': (input: DraftRef) => {
        calls.opens.push(input)
        return { ok: true, value: OPENED_INFO(input) }
      },
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        world.store = { ...STORE, memories: [{ ...STORE.memories[0]!, sizeBytes: 4096 }, STORE.memories[1]!] }
        return { ok: true, value: { label: 'Applied' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  await view.press({ role: 'button', label: 'Edit /runbooks/deploy.md in editor' })
  assert.deepEqual(calls.opens, [{ kind: 'memory', memoryStoreId: 'memstore_a', memoryId: 'mem_a', path: '/runbooks/deploy.md' }])
  // Rien de plus dans la carte : ni texte de brouillon, ni Apply, ni Discard.
  assert.equal(view.find({ text: /Draft open in the editor/ }), null)
  assert.equal(view.findAll({ role: 'button', text: 'Apply' }).length, 0)
  assert.equal(view.findAll({ role: 'button', text: 'Discard' }).length, 0)
  await view.press({ role: 'button', label: 'Open /runbooks/deploy.md' })
  assert.ok(view.find({ text: 'Draft open in the editor. Save it, then press Apply.' }))
  await view.press({ role: 'button', text: 'Apply' })
  assert.ok(view.find({ text: 'Review changes' }))
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(calls.commits.length, 1)
  assert.ok(view.find({ type: 'Callout', text: /Applied/ }))
  await view.press({ role: 'button', text: /Back/ })
  assert.deepEqual(calls.details, ['memstore_a', 'memstore_a'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a refused open from the list shows its notice and the setup card under the row', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      ...NO_DRAFT,
      'drafts.status': { folder: FOLDER, ready: false },
      'draft.open': { ok: false, code: 'drafts_missing', error: 'The drafts folder is not a project yet.' }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_STORE })
  // Avant tout refus, la carte d'installation ne s'affiche pas dans la liste.
  assert.equal(view.find({ type: 'Callout', text: /Add the drafts folder to Orca/ }), null)
  await view.press({ role: 'button', label: 'Edit /runbooks/deploy.md in editor' })
  assert.ok(view.find({ type: 'Callout', text: /Could not open the draft/ }))
  assert.ok(view.find({ type: 'Callout', text: /Add the drafts folder to Orca/ }))
  await view.unmount()
})

test('an unapplied draft shows a status on its row and no Apply or Discard in the card; the detail has them', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld()) }), persisted: OPEN_STORE })
  assert.equal(view.findAll({ text: 'Unapplied draft' }).length, 1)
  assert.ok(calls.states.some((ref) => ref.kind === 'memory' && ref.memoryId === 'mem_b'))
  assert.equal(view.findAll({ role: 'button', text: 'Apply' }).length, 0)
  assert.equal(view.findAll({ role: 'button', text: 'Discard' }).length, 0)
  assert.equal(view.find({ text: /Unapplied draft from/ }), null)
  await view.press({ role: 'button', label: 'Open /runbooks/deploy.md' })
  assert.ok(view.find({ role: 'button', text: 'Apply' }))
  assert.ok(view.find({ role: 'button', text: 'Discard' }))
  await view.unmount()
})

test('the icon that opens a memory is a next arrow, not a menu', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), NO_DRAFT) }), persisted: OPEN_STORE })
  assert.equal(view.find({ role: 'button', label: 'Open /runbooks/deploy.md' })?.props.icon, 'next')
  assert.equal(view.find({ role: 'button', label: 'Edit /runbooks/deploy.md in editor' })?.props.icon, 'edit')
  assert.equal(view.findAll({ role: 'button' }).filter((button) => button.props.icon === 'more').length, 0)
  await view.unmount()
})

test('a row without its file explains why Apply is off, and the line goes away once every row is complete', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), { ...NO_DRAFT, 'file.pick': picks([TODAY]) }) }), persisted: OPEN_STORE })
  assert.equal(view.find({ text: 'Choose a file for every row, or remove it.' }), null)
  await addRows(view, 1)
  assert.ok(view.find({ text: 'Choose a file for every row, or remove it.' }))
  assert.equal(view.find({ role: 'button', text: 'Apply (0)' })?.disabled, true)
  await fillRow(view, 0, '/notes/today.md')
  assert.equal(view.find({ text: 'Choose a file for every row, or remove it.' }), null)
  assert.equal(view.find({ role: 'button', text: 'Apply (1)' })?.disabled, false)
  await view.unmount()
})

test('the refusal notice of an upload is cleared when a row is edited, added or removed', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, newWorld(), { ...NO_DRAFT, 'memory.stageUploads': { ok: false, code: 'invalid', error: NOT_TEXT } })
  })
  const view = await mount(panel, { host, persisted: withRows([SAVED_ROW]) })
  const refuse = async (): Promise<void> => {
    await view.press({ role: 'button', text: 'Apply (1)' })
    assert.ok(view.find({ text: NOT_TEXT }))
  }
  await refuse()
  await view.type(pathFields(view)[0]!, 'x')
  assert.equal(view.find({ text: NOT_TEXT }), null)
  await view.type(pathFields(view)[0]!, '/notes/today.md', { replace: true })
  await refuse()
  await addRows(view, 1)
  assert.equal(view.find({ text: NOT_TEXT }), null)
  // La ligne vide retirée, l'envoi est de nouveau possible ; retirer la dernière ligne referme l'avis aussi.
  await view.press(view.findAll({ role: 'button', label: 'Remove' })[1]!)
  await refuse()
  await view.press({ role: 'button', label: 'Remove' })
  assert.equal(view.find({ text: NOT_TEXT }), null)
  await view.unmount()
})

// --- Gate 3u : correctifs de la revue finale ---

const store = (view: View) => (view.persisted.plugin['memory.uploads'] as Record<string, { id: string; path: string }[]> | undefined)?.memstore_a

test('a row that overlaps a store memory or another row shows the taken message and blocks Apply', async () => {
  const calls = newCalls()
  const row = (id: string, path: string, memoryId: string | null = null) => ({ ...SAVED_ROW, id, path, memoryId })
  const cases: { name: string; rows: unknown[]; flagged: number }[] = [
    { name: 'ancestor of a store memory', rows: [row('r1', '/runbooks')], flagged: 1 },
    { name: 'descendant of a store memory', rows: [row('r1', '/runbooks/deploy.md/deeper.md')], flagged: 1 },
    { name: 'case-insensitive ancestor', rows: [row('r1', '/RUNBOOKS')], flagged: 1 },
    { name: 'ancestor then descendant between rows', rows: [row('r1', '/docs'), row('r2', '/docs/todo.md')], flagged: 1 },
    { name: 'descendant then ancestor between rows', rows: [row('r1', '/docs/todo.md'), row('r2', '/docs')], flagged: 1 },
    // Remplacer une mémoire reste permis : son propre chemin ne la bloque pas.
    { name: 'a replacement of its own memory', rows: [row('r1', '/runbooks/deploy.md', 'mem_a')], flagged: 0 }
  ]
  for (const entry of cases) {
    const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), NO_DRAFT) }), persisted: withRows(entry.rows) })
    assert.equal(view.findAll({ text: PATH_TAKEN }).length, entry.flagged, entry.name)
    if (entry.flagged > 0) {
      assert.equal(view.find({ role: 'button', text: /^Apply/ })?.disabled, true, entry.name)
      assert.equal(view.findAll({ label: 'Memory path' }).filter((field) => field.props.invalid === true).length, entry.flagged, entry.name)
    }
    await view.unmount()
  }
})

test('a conflict after a partial upload keeps the progress, and Reload drops the created row and says how far it went', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      ...NO_DRAFT,
      'write.commit': (input: unknown) => {
        calls.commits.push(input)
        // La création de /notes/a.md est passée ; le remplacement a trouvé la mémoire changée.
        world.store = { ...STORE, memories: [...STORE.memories, { id: 'mem_n', path: '/notes/a.md', sizeBytes: 3, updatedAt: '2026-11-22T11:00:00Z' }] }
        return { ok: false, code: 'conflict', error: 'Uploaded 1 of 2. Changed elsewhere since you opened it.' }
      }
    })
  })
  const view = await mount(panel, { host, persisted: withRows([NEW_A, REPLACE_ROW]) })
  await view.press({ role: 'button', text: 'Apply (2)' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  assert.ok(view.find({ text: /Uploaded 1 of 2\./ }))
  assert.deepEqual(store(view)?.map((entry) => entry.id), ['r2', 'r1'])
  await view.press({ role: 'button', text: 'Reload' })
  assert.deepEqual(store(view)?.map((entry) => entry.id), ['r1'])
  assert.ok(view.find({ text: /Uploaded 1 of 2\./ }))
  assert.equal(view.find({ role: 'button', text: 'Apply anyway' }), null)
  assert.equal(view.find({ role: 'button', text: 'Apply (1)' })?.disabled, false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a conflict with nothing uploaded yet shows no progress line', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, newWorld(), { ...NO_DRAFT, 'write.commit': CONFLICT }) })
  const view = await mount(panel, { host, persisted: withRows([REPLACE_ROW]) })
  await view.press({ role: 'button', text: 'Apply (1)' })
  await view.press({ role: 'button', text: 'Confirm' })
  assert.equal(view.find({ text: /Uploaded \d+ of \d+/ }), null)
  await view.press({ role: 'button', text: 'Reload' })
  assert.equal(view.find({ text: /Uploaded \d+ of \d+/ }), null)
  await view.unmount()
})

test('Delete of a memory with an unapplied draft names the draft file and says it can be uploaded again', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld()) }), persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Delete' })
  assert.ok(
    view.find({
      type: 'Callout',
      text: /Delete \/runbooks\/deploy\.md for good\? This can't be undone\. Your unapplied draft stays in the drafts folder at memories\/notes--memstore_a\/runbooks\/deploy\.md; you can upload it again from To upload\./
    })
  )
  assert.equal(view.find({ text: /new memory/ }), null)
  await view.unmount()
})

test('the draft file named in the Delete question is cut at 200 bytes', async () => {
  const calls = newCalls()
  const long = `memories/notes--memstore_a/${'d'.repeat(300)}.md`
  const info = { ref: { kind: 'memory', memoryStoreId: 'memstore_a', memoryId: 'mem_a', path: '/runbooks/deploy.md' }, file: long, unapplied: true, writtenAt: '2026-11-22T10:00:00Z', savedAt: '2026-11-22T10:42:00Z', returnTo: null }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld(), { 'draft.state': { ok: true, value: info } }) }), persisted: OPEN_MEMORY })
  await view.press({ role: 'button', text: 'Delete' })
  const question = view.find({ type: 'Callout', text: /drafts folder at/ })
  assert.ok(question)
  const shown = String(question.props.title ?? '').match(/drafts folder at (.*); you can upload/)?.[1] ?? ''
  assert.ok(shown.length > 100 && new TextEncoder().encode(shown).length <= 200, `shown ${shown.length}`)
  assert.equal(view.find({ text: new RegExp('d'.repeat(250)) }), null)
  await view.unmount()
})

test('the detail of a memory leads with a solid Edit in editor, then Replace and Rename in outline, and Delete apart below the content', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls, newWorld()) }), persisted: OPEN_MEMORY })
  const edit = view.find({ role: 'button', text: 'Edit in editor' })
  const replace = view.find({ role: 'button', text: 'Replace…' })
  const rename = view.find({ role: 'button', text: 'Rename' })
  const remove = view.find({ role: 'button', text: 'Delete' })
  assert.equal(edit?.props.variant, 'solid')
  assert.equal(replace?.props.variant, 'outline')
  assert.equal(rename?.props.variant, 'outline')
  assert.equal(remove?.props.variant, 'outline')
  assert.equal(remove?.props.tone, 'danger')
  const drawn = JSON.stringify(view.tree())
  const at = (text: string): number => drawn.indexOf(text)
  assert.ok(at('Edit in editor') < at('Replace…'))
  assert.ok(at('Replace…') < at('Rename'))
  assert.ok(at('Rename') < at('Run the script.'))
  // Delete est une rangée à part, après le contenu : jamais à côté des gestes d'édition.
  assert.ok(at('Run the script.') < at('"Delete"'))
  await view.unmount()
})

test('Delete of a memory also removes its pending Replace row, and only that one', async () => {
  const calls = newCalls()
  const world = newWorld()
  const host = mockHost({
    requests: requests(calls, world, {
      ...NO_DRAFT,
      'resource.delete': (input: unknown) => {
        calls.deletes.push(input)
        world.store = { ...STORE, memories: [STORE.memories[1]!] }
        return { ok: true, value: null }
      }
    })
  })
  const persisted = { plugin: { ...OPEN_MEMORY.plugin, 'memory.uploads': { memstore_a: [REPLACE_ROW, NEW_A, { ...REPLACE_ROW, id: 'r4', path: '/runbooks/rollback.md', memoryId: 'mem_b' }] } } }
  const view = await mount(panel, { host, persisted })
  await view.press({ role: 'button', text: 'Delete' })
  await pressConfirm(view, 'Delete')
  assert.equal(calls.deletes.length, 1)
  assert.deepEqual(store(view)?.map((entry) => entry.id), ['r2', 'r4'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Apply stays disabled while a file dialog is open', async () => {
  const calls = newCalls()
  let duringPick: boolean | undefined
  let current: View | null = null
  const host = mockHost({
    requests: requests(calls, newWorld(), {
      ...NO_DRAFT,
      'file.pick': async () => {
        // La boîte est ouverte : on lit l'écran pendant que la demande est en vol.
        await new Promise((resolve) => setTimeout(resolve, 20))
        duringPick = current?.find({ role: 'button', text: 'Apply (1)' })?.disabled
        return { ok: true, value: TODO }
      }
    })
  })
  // Une ligne complète dont on change le fichier : sans la boîte ouverte, Apply serait actif.
  const view = await mount(panel, { host, persisted: withRows([SAVED_ROW]) })
  current = view
  assert.equal(view.find({ role: 'button', text: 'Apply (1)' })?.disabled, false)
  await view.press(fileButtons(view)[0]!)
  assert.equal(duringPick, true)
  assert.equal(view.find({ role: 'button', text: 'Apply (1)' })?.disabled, false)
  await view.unmount()
})
