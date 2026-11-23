import { read } from 'orca'
import { assert, hostError, mockHost, mount, test, type TestPanel, type TestQuery } from 'orca/testing'
import { RESOURCE_UPLOAD_WAIT_MS, UPLOAD_UNCONFIRMED, type FileRow, type SessionRow, type SkillRow, type WorkspaceInfo } from '../protocol'
import * as panel from '../panel'
import { notice } from './state'
import { PICK_TIMEOUT_MS } from './memory-uploads'

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

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')

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
  // Deux vraies lectures en vol, lancées par deux appuis sur l'onglet : les gestes ne sont pas attendus.
  const pressedFirst = view.press({ role: 'button', text: 'Resources' })
  const pressedSecond = view.press({ role: 'button', text: 'Resources' })
  try {
    await tick()
    assert.equal(reads, 2)
    // La lecture la plus récente répond d'abord, la plus ancienne arrive après : elle n'écrase rien.
    second.open()
    await tick()
    first.open()
  } finally {
    first.open()
    second.open()
  }
  await pressedFirst
  await pressedSecond
  await view.settled()
  assert.ok(view.find({ text: 'second-read.md' }))
  assert.equal(view.find({ text: 'first-read.md' }), null)
  await view.unmount()
})

test('a list refused as unauthorized reads the workspace identity again', async () => {
  let infoReads = 0
  const host = mockHost({
    requests: requests({
      'workspace.info': () => {
        infoReads += 1
        return FIRST
      },
      'skills.list': { ok: false, code: 'unauthorized', error: 'The API key was rejected (401).' }
    })
  })
  const view = await mount(panel, { host, persisted: FROM_SESSIONS })
  const before = infoReads
  await view.press({ role: 'button', text: 'Resources' })
  assert.equal(infoReads, before + 1)
  await view.unmount()
})

// --- Actions des cartes ---

type View = Awaited<ReturnType<typeof mount>>

const SKILL_FOLDER = { file: '/x/plugin-test-skill/', name: 'plugin-test-skill' }
const FILE_PICKED = { file: '/x/plugin-test-file.md', name: 'plugin-test-file.md' }
const SKILL_ID = 'skill_01VrVvGsN66DzQ71c6Sr3fbB'

/** Presse le dernier bouton de ce texte : la question de confirmation s'ouvre après le bouton du geste. */
async function pressConfirm(view: View, text: string): Promise<void> {
  const last = view.findAll({ role: 'button', text }).at(-1)
  assert.ok(last, `no ${text} button`)
  await view.press(last)
}

const iconButton = (view: View, label: string | RegExp) => view.find({ type: 'IconButton', label })
const addSkill = { type: 'IconButton', label: 'Upload skill' } as const
const addFile = { type: 'IconButton', label: 'Upload file' } as const
const callout = (view: View, text: string | RegExp) => view.find({ type: 'Callout', text })

test('+ on Skills picks a folder, uploads it, shows the notice and rereads the list', async () => {
  const uploads: unknown[] = []
  let lists = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        lists += 1
        return { ok: true, value: lists === 1 ? [] : [skill({ name: 'plugin-test-skill' })] }
      },
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.upload': (input: unknown) => {
        uploads.push(input)
        return { ok: true, value: skill({ name: 'plugin-test-skill' }) }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  assert.equal(lists, 1)
  await view.press(addSkill)
  assert.deepEqual(uploads, [{ folder: '/x/plugin-test-skill/' }])
  assert.equal(lists, 2)
  assert.ok(callout(view, /Uploaded plugin-test-skill\./))
  assert.ok(view.find({ text: 'plugin-test-skill' }))
  assert.equal(view.find({ type: 'Spinner' }), null)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('+ on Files picks a file and uploads it the same way', async () => {
  const uploads: unknown[] = []
  let lists = 0
  const host = mockHost({
    requests: requests({
      'files.list': () => {
        lists += 1
        return { ok: true, value: lists === 1 ? [] : [file({ name: 'plugin-test-file.md' })] }
      },
      'files.pickFile': { ok: true, value: FILE_PICKED },
      'files.upload': (input: unknown) => {
        uploads.push(input)
        return { ok: true, value: file({ name: 'plugin-test-file.md' }) }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addFile)
  assert.deepEqual(uploads, [{ file: '/x/plugin-test-file.md' }])
  assert.equal(lists, 2)
  assert.ok(callout(view, /Uploaded plugin-test-file\.md\./))
  assert.ok(view.find({ text: 'plugin-test-file.md' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a cancelled dialog sends nothing and shows nothing', async () => {
  const uploads: unknown[] = []
  const host = mockHost({
    requests: requests({
      'skills.pickFolder': { ok: true, value: null },
      'skills.upload': (input: unknown) => {
        uploads.push(input)
        return { ok: true, value: skill() }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addSkill)
  assert.deepEqual(uploads, [])
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.equal(view.find({ type: 'Spinner' }), null)
  assert.equal(iconButton(view, 'Upload skill')?.disabled, false)
  await view.unmount()
})

test('during an upload the card shows Uploading and disables + and every ↑, not the X', async () => {
  const pending = gate()
  const host = mockHost({
    requests: requests({
      'skills.list': { ok: true, value: [skill()] },
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.upload': async () => {
        await pending.closed
        return { ok: true, value: skill({ name: 'plugin-test-skill' }) }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  const pressed = view.press(addSkill)
  try {
    await tick()
    assert.ok(view.find({ type: 'Spinner', label: 'Uploading plugin-test-skill' }))
    assert.equal(iconButton(view, 'Upload skill')?.disabled, true)
    assert.equal(iconButton(view, 'Upload a new version of teach')?.disabled, true)
    assert.equal(iconButton(view, 'Delete teach')?.disabled, false)
    // La carte des fichiers reste libre.
    assert.equal(iconButton(view, 'Upload file')?.disabled, false)
  } finally {
    pending.open()
  }
  await pressed
  await view.settled()
  assert.equal(view.find({ type: 'Spinner', label: 'Uploading plugin-test-skill' }), null)
  assert.equal(iconButton(view, 'Upload skill')?.disabled, false)
  await view.unmount()
})

test('while a dialog is open, + and every ↑ of the card are disabled', async () => {
  const pending = gate()
  const uploads: unknown[] = []
  const host = mockHost({
    requests: requests({
      'skills.list': { ok: true, value: [skill()] },
      'skills.pickFolder': async () => {
        await pending.closed
        return { ok: true, value: SKILL_FOLDER }
      },
      'skills.upload': (input: unknown) => {
        uploads.push(input)
        return { ok: true, value: skill({ name: 'plugin-test-skill' }) }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  const pressed = view.press(addSkill)
  try {
    await tick()
    assert.equal(iconButton(view, 'Upload skill')?.disabled, true)
    assert.equal(iconButton(view, 'Upload a new version of teach')?.disabled, true)
    // La carte des fichiers n'est pas concernée.
    assert.equal(iconButton(view, 'Upload file')?.disabled, false)
  } finally {
    pending.open()
  }
  await pressed
  await view.settled()
  // Un seul choix, un seul envoi.
  assert.deepEqual(uploads, [{ folder: '/x/plugin-test-skill/' }])
  assert.equal(iconButton(view, 'Upload skill')?.disabled, false)
  await view.unmount()
})

test('an upload whose wait runs out says it may have gone through and rereads the list', async () => {
  let lists = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        lists += 1
        return { ok: true, value: [] }
      },
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.upload': () => {
        throw hostError('timeout', 'The worker took too long')
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addSkill)
  assert.ok(callout(view, UPLOAD_UNCONFIRMED))
  assert.equal(lists, 2)
  assert.equal(read(notice), null)
  assert.equal(iconButton(view, 'Upload skill')?.disabled, false)
  await view.unmount()
})

test('the picker waits as long as Orca allows and the upload waits for the API', async () => {
  const host = mockHost({
    requests: requests({
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.upload': { ok: true, value: skill({ name: 'plugin-test-skill' }) }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addSkill)
  const timeouts = (name: string): unknown[] =>
    host.calls
      .filter((call) => call.method === 'plugin.request' && (call.params as { name?: string }).name === name)
      .map((call) => (call.params as { timeoutMs?: number }).timeoutMs)
  assert.deepEqual(timeouts('skills.pickFolder'), [PICK_TIMEOUT_MS])
  assert.deepEqual(timeouts('skills.upload'), [RESOURCE_UPLOAD_WAIT_MS])
  await view.unmount()
})

test('a 2000-character name stays renderable in the spinner, the action labels and the question', async () => {
  const pending = gate()
  const long = 'S'.repeat(2000)
  const host = mockHost({
    requests: requests({
      'skills.list': { ok: true, value: [skill({ name: long })] },
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.uploadVersion': async () => {
        await pending.closed
        return { ok: true, value: { versionId: 'skillver_2' } }
      },
      'skills.delete': { ok: true, value: null }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  const pressed = view.press({ type: 'IconButton', label: /^Upload a new version of S+$/ })
  try {
    await tick()
    const spinner = view.find({ type: 'Spinner', label: /^Uploading S+$/ })
    assert.ok(spinner)
    assert.ok(bytesOf(spinner.props.label as string) <= 400)
    assert.deepEqual(view.refusals, [])
  } finally {
    pending.open()
  }
  await pressed
  await view.settled()
  assert.ok(callout(view, /^New version of S+ uploaded\.$/))
  await view.press({ type: 'IconButton', label: /^Delete S+$/ })
  assert.ok(callout(view, /^Delete S+ for good\?/))
  await pressConfirm(view, 'Delete')
  assert.ok(callout(view, /^Deleted S+\.$/))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('↑ uploads a new version of that skill id and says so', async () => {
  const versions: unknown[] = []
  let lists = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        lists += 1
        return { ok: true, value: [skill()] }
      },
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.uploadVersion': (input: unknown) => {
        versions.push(input)
        return { ok: true, value: { versionId: 'skillver_2' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press({ type: 'IconButton', label: 'Upload a new version of teach' })
  assert.deepEqual(versions, [{ skillId: SKILL_ID, folder: '/x/plugin-test-skill/' }])
  assert.ok(callout(view, /New version of teach uploaded\./))
  assert.equal(lists, 2)
  await view.unmount()
})

test('a refused new version shows the API text on the Skills card', async () => {
  const apiText =
    "API error 400: Skill name 'other' in SKILL.md must be consistent across all versions for a given `skill_id`. Expected 'teach'."
  const host = mockHost({
    requests: requests({
      'skills.list': { ok: true, value: [skill()] },
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.uploadVersion': { ok: false, code: 'other', error: apiText }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press({ type: 'IconButton', label: 'Upload a new version of teach' })
  const refused = view.find({ type: 'Callout', text: /Could not upload/ })
  assert.ok(refused)
  assert.ok(view.find({ type: 'Text', text: apiText }))
  assert.equal(read(notice), null)
  await view.unmount()
})

test('a refusal before the API shows the worker text', async () => {
  const host = mockHost({
    requests: requests({
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.upload': { ok: false, code: 'invalid', error: 'This folder has no SKILL.md at its root.' }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addSkill)
  assert.ok(callout(view, /Could not upload/))
  assert.ok(view.find({ type: 'Text', text: 'This folder has no SKILL.md at its root.' }))
  await view.unmount()
})

test('an unconfirmed upload says it may have gone through and rereads the list', async () => {
  let lists = 0
  const host = mockHost({
    requests: requests({
      'files.list': () => {
        lists += 1
        return { ok: true, value: [] }
      },
      'files.pickFile': { ok: true, value: FILE_PICKED },
      'files.upload': { ok: false, code: 'other', error: UPLOAD_UNCONFIRMED }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addFile)
  assert.ok(callout(view, UPLOAD_UNCONFIRMED))
  assert.equal(callout(view, /Could not upload/), null)
  assert.equal(lists, 2)
  await view.unmount()
})

test('X asks first; Cancel deletes nothing; Delete deletes, rereads and says Deleted', async () => {
  const deleted: unknown[] = []
  let skillLists = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        skillLists += 1
        return { ok: true, value: skillLists === 1 ? [skill()] : [] }
      },
      'files.list': { ok: true, value: [file()] },
      'skills.delete': (input: unknown) => {
        deleted.push(input)
        return { ok: true, value: null }
      },
      'files.delete': (input: unknown) => {
        deleted.push(input)
        return { ok: true, value: null }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press({ type: 'IconButton', label: 'Delete teach' })
  assert.ok(callout(view, /Delete teach for good\? This can't be undone\. Agents that use this skill will no longer find it\./))
  await pressConfirm(view, 'Cancel')
  assert.deepEqual(deleted, [])
  assert.equal(view.find({ type: 'Callout' }), null)

  await view.press({ type: 'IconButton', label: 'Delete teach' })
  await pressConfirm(view, 'Delete')
  assert.deepEqual(deleted, [{ skillId: SKILL_ID }])
  assert.equal(skillLists, 2)
  assert.equal(view.find({ text: 'teach' }), null)
  assert.ok(callout(view, /Deleted teach\./))
  assert.ok(view.find({ text: 'No skills yet.' }))

  // La question d'un fichier ne parle pas des agents.
  await view.press({ type: 'IconButton', label: 'Delete lecon.md' })
  const question = callout(view, /Delete lecon\.md for good\?/)
  assert.ok(question)
  assert.ok(!question.text.includes('Agents that use'))
  await pressConfirm(view, 'Delete')
  assert.deepEqual(deleted, [{ skillId: SKILL_ID }, { fileId: 'file_01Rg1GjABf38591B94kdYEvg' }])
  assert.ok(callout(view, /Deleted lecon\.md\./))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a delete refused with 404 rereads the list and the row is gone', async () => {
  let lists = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        lists += 1
        return { ok: true, value: lists === 1 ? [skill()] : [] }
      },
      'skills.delete': { ok: false, code: 'other', error: 'Not found (404).' }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press({ type: 'IconButton', label: 'Delete teach' })
  await pressConfirm(view, 'Delete')
  assert.equal(lists, 2)
  assert.equal(view.find({ text: 'teach' }), null)
  assert.ok(callout(view, /Could not delete/))
  assert.ok(view.find({ type: 'Text', text: 'Not found (404).' }))
  // L'erreur ne s'affiche qu'une fois : sur la carte, pas dans le bandeau du haut.
  assert.equal(read(notice), null)
  // La question s'est fermée.
  assert.equal(view.find({ role: 'button', text: 'Cancel' }), null)
  await view.unmount()
})

test('a dialog still open after the wait says so, and the next press joins it', async () => {
  const uploads: unknown[] = []
  let picks = 0
  const host = mockHost({
    requests: requests({
      'skills.pickFolder': () => {
        picks += 1
        if (picks === 1) throw hostError('timeout', 'The worker took too long')
        return { ok: true, value: SKILL_FOLDER }
      },
      'skills.upload': (input: unknown) => {
        uploads.push(input)
        return { ok: true, value: skill({ name: 'plugin-test-skill' }) }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addSkill)
  assert.ok(callout(view, 'The dialog is still open. Press the button again to wait for your choice.'))
  assert.equal(read(notice), null)
  assert.deepEqual(uploads, [])
  // La carte reste utilisable : le second appui reçoit le choix et l'envoi part.
  assert.equal(iconButton(view, 'Upload skill')?.disabled, false)
  await view.press(addSkill)
  assert.equal(picks, 2)
  assert.deepEqual(uploads, [{ folder: '/x/plugin-test-skill/' }])
  assert.equal(callout(view, /still open/), null)
  assert.ok(callout(view, /Uploaded plugin-test-skill\./))
  await view.unmount()
})

test('a pick that ends after a workspace switch shows nothing and sends nothing', async () => {
  const pending = gate()
  const uploads: unknown[] = []
  const host = mockHost({
    requests: requests({
      'skills.pickFolder': async () => {
        await pending.closed
        return { ok: true, value: SKILL_FOLDER }
      },
      'skills.upload': (input: unknown) => {
        uploads.push(input)
        return { ok: true, value: skill() }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  const pressed = view.press(addSkill)
  let switched: Promise<void> | undefined
  try {
    await tick()
    switched = view.post('workspace.changed', SECOND)
    await tick()
    await tick()
  } finally {
    pending.open()
  }
  await pressed
  await switched
  await view.settled()
  assert.deepEqual(uploads, [])
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.equal(view.find({ type: 'Spinner' }), null)
  assert.equal(iconButton(view, 'Upload skill')?.disabled, false)
  await view.unmount()
})

test('an upload that ends after a workspace switch shows no notice', async () => {
  const pending = gate()
  const host = mockHost({
    requests: requests({
      'skills.pickFolder': { ok: true, value: SKILL_FOLDER },
      'skills.upload': async () => {
        await pending.closed
        return { ok: true, value: skill({ name: 'plugin-test-skill' }) }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  const pressed = view.press(addSkill)
  let switched: Promise<void> | undefined
  try {
    await tick()
    switched = view.post('workspace.changed', SECOND)
    await tick()
    await tick()
  } finally {
    pending.open()
  }
  await pressed
  await switched
  await view.settled()
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.equal(view.find({ type: 'Spinner' }), null)
  assert.equal(iconButton(view, 'Upload skill')?.disabled, false)
  await view.unmount()
})

test('an upload the host rejects shows the text on the card, not in the banner, and rereads the list', async () => {
  let lists = 0
  const host = mockHost({
    requests: requests({
      'files.list': () => {
        lists += 1
        return { ok: true, value: [] }
      },
      'files.pickFile': { ok: true, value: FILE_PICKED },
      'files.upload': () => {
        throw hostError('unavailable', 'The worker is not running')
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press(addFile)
  assert.ok(callout(view, /Could not upload/))
  assert.ok(view.find({ type: 'Text', text: 'The worker is not running' }))
  assert.equal(read(notice), null)
  assert.equal(lists, 2)
  assert.equal(iconButton(view, 'Upload file')?.disabled, false)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a delete the host rejects shows the text on the card, closes the question and rereads the list', async () => {
  let lists = 0
  const host = mockHost({
    requests: requests({
      'skills.list': () => {
        lists += 1
        return { ok: true, value: [skill()] }
      },
      'skills.delete': () => {
        throw hostError('timeout', 'The worker took too long')
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN })
  await view.press({ type: 'IconButton', label: 'Delete teach' })
  await pressConfirm(view, 'Delete')
  assert.ok(callout(view, /Could not delete/))
  assert.ok(view.find({ type: 'Text', text: 'The worker took too long' }))
  assert.equal(read(notice), null)
  assert.equal(lists, 2)
  assert.equal(view.find({ role: 'button', text: 'Cancel' }), null)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})
