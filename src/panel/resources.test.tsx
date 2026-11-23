import { read } from 'orca'
import { assert, mockHost, mount, test, type TestPanel, type TestQuery } from 'orca/testing'
import type { FileRow, SessionRow, SkillRow, WorkspaceInfo } from '../protocol'
import * as panel from '../panel'
import { fileRows, loadFiles } from './resource-state'

const FIRST: WorkspaceInfo = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_default',
  workspaces: [
    { localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_default', active: true },
    { localId: 'ws_2', name: 'Other', workspaceId: 'wrkspc_other', active: false }
  ]
}
/** Le même état, avec l'autre workspace actif : ce que `workspace.changed` apporte au panneau. */
const SECOND: WorkspaceInfo = {
  ...FIRST,
  workspaceId: 'wrkspc_other',
  workspaces: FIRST.workspaces.map((row) => ({ ...row, active: row.localId === 'ws_2' }))
}

const OPEN = { plugin: { 'home.tab': 'resources' } }
const FROM_SESSIONS = { plugin: { 'home.tab': 'sessions' } }

const skill = (over: Partial<SkillRow> = {}): SkillRow => ({
  id: 'skill_01VrVvGsN66DzQ71c6Sr3fbB',
  name: 'teach',
  latestVersionId: 'skillver_1',
  updatedAt: '2026-11-23T10:00:00Z',
  ...over
})
const file = (over: Partial<FileRow> = {}): FileRow => ({
  id: 'file_01Rg1GjABf38591B94kdYEvg',
  name: 'lecon.md',
  sizeBytes: 9441,
  createdAt: '2026-11-23T10:00:00Z',
  sessionId: null,
  ...over
})
const session = (over: Partial<SessionRow> = {}): SessionRow =>
  ({ id: 'sesn_1', title: 'Audit', ...over }) as SessionRow

/** Les lectures communes de l'accueil ; `over` remplace ou complète. */
function requests(over: Record<string, unknown> = {}) {
  return {
    'workspace.info': FIRST,
    'sessions.visibility': { bootId: 'boot-1', watching: null },
    'sessions.list': { ok: true, value: [] },
    'configs.list': { ok: true, value: [] },
    'skills.list': { ok: true, value: [] },
    'files.list': { ok: true, value: [] },
    ...over
  } as never
}

/** Une porte : la requête qui l'attend reste en vol jusqu'à `open`. */
function gate() {
  let open: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    open = resolve
  })
  return { closed, open }
}

/** Un tour de boucle d'événements : `rerender` et `settled` attendent les lectures en vol, un test qui en tient une ouverte ne peut pas les appeler. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15))

/** Laisse passer des tours jusqu'à ce que la requête trouve un élément. */
async function until(view: TestPanel, query: TestQuery): Promise<void> {
  for (let attempt = 0; attempt < 30 && view.find(query) === null; attempt += 1) await tick()
}

const bytesOf =(text: string): number => Buffer.byteLength(text, 'utf8')

test('shows custom skills and files with their ids, and the size of a file', async () => {
  const host = mockHost({
    requests: requests({ 'skills.list': { ok: true, value: [skill()] }, 'files.list': { ok: true, value: [file()] } })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  assert.ok(view.find({ text: 'Skills' }))
  assert.ok(view.find({ text: 'Files' }))
  assert.ok(view.find({ text: 'teach' }))
  assert.ok(view.find({ text: 'skill_01VrVvGsN66DzQ71c6Sr3fbB' }))
  assert.ok(view.find({ text: 'lecon.md' }))
  assert.ok(view.find({ text: 'file_01Rg1GjABf38591B94kdYEvg · 9.4 kB' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Upload skill' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Upload file' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a session-scoped file shows the session title, or its id when the session is unknown', async () => {
  const host = mockHost({
    requests: requests({
      'sessions.list': { ok: true, value: [session()] },
      'files.list': {
        ok: true,
        value: [
          file({ id: 'file_known', name: 'known.md', sessionId: 'sesn_1' }),
          file({ id: 'file_lost', name: 'lost.md', sessionId: 'sesn_gone' })
        ]
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  assert.ok(view.find({ text: 'file_known · 9.4 kB · Audit' }))
  assert.ok(view.find({ text: 'file_lost · 9.4 kB · sesn_gone' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('empty lists say No skills yet and No files yet', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests() }), persisted: OPEN })
  assert.ok(view.find({ text: 'No skills yet.' }))
  assert.ok(view.find({ text: 'No files yet.' }))
  assert.equal(view.find({ type: 'Spinner' }), null)
  await view.unmount()
})

test('the filter keeps rows whose name or id contains the text, in both cards, and leaves other tabs alone', async () => {
  const host = mockHost({
    requests: requests({
      'skills.list': {
        ok: true,
        value: [skill({ id: 'skill_a', name: 'plugin-test-skill' }), skill({ id: 'skill_b', name: 'teach' })]
      },
      'files.list': {
        ok: true,
        value: [file({ id: 'file_plugin-test-id', name: 'by-id.md' }), file({ id: 'file_other', name: 'other.md' })]
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  assert.ok(view.find({ text: 'teach' }))
  await view.type({ label: 'Filter' }, 'plugin-test')
  assert.ok(view.find({ text: 'plugin-test-skill' }))
  assert.equal(view.find({ text: 'teach' }), null)
  // Le filtre porte aussi sur l'identifiant.
  assert.ok(view.find({ text: 'by-id.md' }))
  assert.equal(view.find({ text: 'other.md' }), null)

  await view.type({ label: 'Filter' }, 'zzz', { replace: true })
  assert.equal(view.findAll({ type: 'Text', text: 'No match' }).length, 2)

  // Le texte vaut pour l'onglet Resources seulement : les autres gardent leur filtre vide.
  const filters = view.persisted.plugin['home.filters'] as Record<string, string>
  assert.equal(filters.resources, 'zzz')
  assert.equal(filters.agent, undefined)
  await view.press({ role: 'button', text: 'Agents' })
  assert.equal(view.valueOf({ label: 'Filter' }), '')
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('clips a name of 2000 characters instead of letting Orca refuse the render', async () => {
  const host = mockHost({
    requests: requests({
      'sessions.list': { ok: true, value: [session({ title: 'T'.repeat(2000) })] },
      'skills.list': { ok: true, value: [skill({ name: 'S'.repeat(2000) })] },
      'files.list': { ok: true, value: [file({ id: 'file_long', name: 'F'.repeat(2000), sessionId: 'sesn_1' })] }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  assert.deepEqual(view.refusals, [])
  assert.deepEqual([view.errors, view.warnings], [[], []])
  const titles = [...view.findAll({ type: 'Text', text: /^S+$/ }), ...view.findAll({ type: 'Text', text: /^F+$/ })]
  assert.equal(titles.length, 2)
  for (const title of titles) assert.ok(bytesOf(title.text) <= 200, `title of ${bytesOf(title.text)} bytes`)
  // Le sous-titre d'un fichier porte l'identifiant puis le titre de session de 2000 caractères.
  const subtitle = view.find({ type: 'Text', text: /^file_long · / })
  assert.ok(subtitle)
  assert.ok(bytesOf(subtitle.text) <= 300, `subtitle of ${bytesOf(subtitle.text)} bytes`)
  await view.unmount()
})

test('a list that fails says so with Retry, and Retry reads it again', async () => {
  let reads = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        reads += 1
        return reads === 1
          ? { ok: false, code: 'other', error: 'Rate limited (429). Try again shortly.' }
          : { ok: true, value: [skill()] }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  assert.ok(view.find({ type: 'Callout', text: /Rate limited \(429\)/ }))
  assert.equal(view.find({ text: 'teach' }), null)
  // La carte des fichiers, elle, se lit.
  assert.ok(view.find({ text: 'No files yet.' }))
  await view.press({ role: 'button', text: 'Retry' })
  assert.ok(view.find({ text: 'teach' }))
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a card shows a spinner until its list arrives, not No skills yet', async () => {
  const pending = gate()
  const host = mockHost({
    requests: requests({
      'skills.list': async () => {
        await pending.closed
        return { ok: true, value: [skill()] }
      }
    })
  })
  const view = await mount(panel, { host, persisted: FROM_SESSIONS })
  // L'appui n'est pas attendu : il ne revient qu'une fois la lecture en vol terminée.
  const pressed = view.press({ role: 'button', text: 'Resources' })
  try {
    await tick()
    assert.ok(view.find({ type: 'Spinner', label: 'Loading skills' }))
    assert.equal(view.find({ text: 'No skills yet.' }), null)
    // La carte des fichiers n'attend pas l'autre.
    assert.ok(view.find({ text: 'No files yet.' }))
  } finally {
    pending.open()
  }
  await pressed
  await view.settled()
  assert.equal(view.find({ type: 'Spinner' }), null)
  assert.ok(view.find({ text: 'teach' }))
  await view.unmount()
})

test('selecting the Resources tab reads both lists', async () => {
  const reads = { skills: 0, files: 0 }
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        reads.skills += 1
        return { ok: true, value: [] }
      },
      'files.list': () => {
        reads.files += 1
        return { ok: true, value: [] }
      }
    })
  })
  const view = await mount(panel, { host, persisted: FROM_SESSIONS })
  assert.deepEqual(reads, { skills: 0, files: 0 })
  await view.press({ role: 'button', text: 'Resources' })
  assert.deepEqual(reads, { skills: 1, files: 1 })
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a workspace switch empties the cards and reads the lists of the new workspace', async () => {
  let reads = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        reads += 1
        return reads === 1 ? { ok: true, value: [skill({ name: 'old-skill' })] } : { ok: true, value: [skill({ name: 'new-skill' })] }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  assert.ok(view.find({ text: 'old-skill' }))
  await view.post('workspace.changed', SECOND)
  assert.equal(view.find({ text: 'old-skill' }), null)
  assert.ok(view.find({ text: 'new-skill' }))
  assert.equal(reads, 2)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a list answer that arrives after a workspace switch is dropped', async () => {
  const oldAnswer = gate()
  let reads = 0
  const host = mockHost({
    requests: requests({
      'skills.list': async () => {
        reads += 1
        if (reads === 1) {
          await oldAnswer.closed
          return { ok: true, value: [skill({ name: 'old-skill' })] }
        }
        return { ok: true, value: [skill({ name: 'new-skill' })] }
      }
    })
  })
  const view = await mount(panel, { host, persisted: FROM_SESSIONS })
  // Les gestes ne sont pas attendus : la lecture de l'ancien workspace reste en vol.
  const pressed = view.press({ role: 'button', text: 'Resources' })
  try {
    await tick()
    assert.equal(reads, 1)
    const switched = view.post('workspace.changed', SECOND)
    await until(view, { text: 'new-skill' })
    assert.ok(view.find({ text: 'new-skill' }))
    // L'ancienne réponse arrive enfin : elle ne repeint pas le nouveau workspace.
    oldAnswer.open()
    await pressed
    await switched
  } finally {
    oldAnswer.open()
  }
  await view.settled()
  assert.equal(view.find({ text: 'old-skill' }), null)
  assert.ok(view.find({ text: 'new-skill' }))
  await view.unmount()
})

test('an older list answer never overwrites a newer one', async () => {
  const first = gate()
  const second = gate()
  let reads = 0
  const host = mockHost({
    requests: requests({
      'files.list': async () => {
        reads += 1
        if (reads === 1) {
          await first.closed
          return { ok: true, value: [file({ name: 'first-read.md' })] }
        }
        await second.closed
        return { ok: true, value: [file({ name: 'second-read.md' })] }
      }
    })
  })
  const view = await mount(panel, { host, persisted: FROM_SESSIONS })
  // Deux lectures en vol, lancées par le panneau lui-même : le harnais ne sait pas en tenir deux par des gestes.
  const slow = loadFiles()
  const fresh = loadFiles()
  try {
    await tick()
    assert.equal(reads, 2)
    second.open()
    await fresh
    assert.deepEqual(read(fileRows)?.map((row) => row.name), ['second-read.md'])
    // La première réponse, partie avant, arrive après : elle n'écrase pas la plus fraîche.
    first.open()
    await slow
  } finally {
    first.open()
    second.open()
  }
  assert.deepEqual(read(fileRows)?.map((row) => row.name), ['second-read.md'])
  await view.unmount()
})
