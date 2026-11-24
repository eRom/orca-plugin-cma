import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REGISTRY_FILE, type Drafts } from './drafts'
import {
  DRAFTS_PROJECT_KEY,
  DRAFTS_SUBFOLDER,
  createDraftsLocation,
  guardDrafts,
  type KeyStore,
  type ProjectSource
} from './drafts-location'

type Row = Awaited<ReturnType<ProjectSource>>[number]

const dirs: string[] = []
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cma-location-'))
  dirs.push(root)
  return root
}

function cleanup(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Un projet local de la barre latérale, dont le dossier existe dans un répertoire temporaire. */
function project(id: string, name: string, extra: Partial<Row> = {}): Row {
  const path = join(tempDir(), name)
  mkdirSync(path, { recursive: true })
  return { id, name, kind: 'folder', hostId: 'local', path, ...extra }
}

function fakeStore(initial?: string) {
  const data = new Map<string, unknown>()
  if (initial !== undefined) {
    data.set(DRAFTS_PROJECT_KEY, initial)
  }
  const store: KeyStore = {
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    }
  }
  return { store, data }
}

function fakeLocation(
  rows: Row[],
  options: { initial?: string; legacyFolder?: string; rename?: typeof import('node:fs/promises').rename } = {}
) {
  const { store, data } = fakeStore(options.initial)
  const logs: string[] = []
  const location = createDraftsLocation({
    projects: async () => rows,
    store,
    legacyFolder: options.legacyFolder ?? join(tempDir(), 'legacy'),
    log: (message) => logs.push(message),
    rename: options.rename
  })
  return { location, data, logs }
}

const draftsOf = (row: Row): string => join(row.path, DRAFTS_SUBFOLDER)

/** Un dossier de brouillons peuplé : un registre à une entrée, un agent, une mémoire, un fichier récupéré. */
function populate(folder: string): void {
  mkdirSync(join(folder, 'agents'), { recursive: true })
  mkdirSync(join(folder, 'memories', 's'), { recursive: true })
  writeFileSync(join(folder, REGISTRY_FILE), JSON.stringify({ entries: { 'agents/a.yaml': { kind: 'agent' } }, lastReturnTo: null }))
  writeFileSync(join(folder, 'agents', 'a.yaml'), 'name: a\n')
  writeFileSync(join(folder, 'agents', 'a.yaml.recovered-1'), 'name: old\n')
  writeFileSync(join(folder, 'memories', 's', 'x.md'), 'memory\n')
  writeFileSync(join(folder, '.gitignore'), '*\n')
}

const EXPECTED_FILES = [
  [REGISTRY_FILE, undefined],
  [join('agents', 'a.yaml'), 'name: a\n'],
  [join('agents', 'a.yaml.recovered-1'), 'name: old\n'],
  [join('memories', 's', 'x.md'), 'memory\n']
] as const

function expectMovedTo(folder: string): void {
  for (const [file, content] of EXPECTED_FILES) {
    expect(existsSync(join(folder, file))).toBe(true)
    if (content !== undefined) {
      expect(readFileSync(join(folder, file), 'utf8')).toBe(content)
    }
  }
}

test('projects lists local visible projects sorted by name', async () => {
  const rows = [
    project('p-b', 'B', { kind: 'git' }),
    project('p-a', 'a', { hostId: null }),
    project('p-hidden', 'hidden', { hidden: true }),
    project('p-ssh', 'ssh', { kind: 'git', hostId: 'ssh:x' })
  ]
  const { location } = fakeLocation(rows)
  const listed = await location.projects()
  expect(listed.map((entry) => entry.name)).toEqual(['a', 'B'])
  expect(listed.map((entry) => entry.current)).toEqual([false, false])
  expect(listed.map((entry) => entry.path)).toEqual([rows[1].path, rows[0].path])
  cleanup()
})

test('folder is null until a project is chosen', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location } = fakeLocation(rows)
  expect(await location.folder()).toBe(null)
  const result = await location.choose('p1')
  expect(result).toEqual({ ok: true, value: { folder: draftsOf(rows[0]) } })
  expect(await location.folder()).toBe(draftsOf(rows[0]))
  const listed = await location.projects()
  expect(listed.map((entry) => [entry.id, entry.current])).toEqual([
    ['p1', true],
    ['p2', false]
  ])
  cleanup()
})

test('choose writes a .gitignore with *', async () => {
  const rows = [project('p1', 'one')]
  const { location } = fakeLocation(rows)
  await location.choose('p1')
  expect(readFileSync(join(draftsOf(rows[0]), '.gitignore'), 'utf8')).toBe('*\n')
  cleanup()
})

test('keeps an existing .gitignore', async () => {
  const rows = [project('p1', 'one')]
  mkdirSync(draftsOf(rows[0]))
  writeFileSync(join(draftsOf(rows[0]), '.gitignore'), 'custom\n')
  const { location } = fakeLocation(rows)
  await location.choose('p1')
  expect(readFileSync(join(draftsOf(rows[0]), '.gitignore'), 'utf8')).toBe('custom\n')
  cleanup()
})

test('changing project moves the drafts', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location, data } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  const result = await location.choose('p2')
  expect(result).toEqual({ ok: true, value: { folder: draftsOf(rows[1]) } })
  expectMovedTo(draftsOf(rows[1]))
  expect(readFileSync(join(draftsOf(rows[1]), '.gitignore'), 'utf8')).toBe('*\n')
  expect(existsSync(draftsOf(rows[0]))).toBe(false)
  expect(data.get(DRAFTS_PROJECT_KEY)).toBe('p2')
  cleanup()
})

test('refuses when the target already holds drafts', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location, data } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  mkdirSync(draftsOf(rows[1]))
  const targetRegistry = JSON.stringify({ entries: { 'agents/b.yaml': { kind: 'agent' } }, lastReturnTo: null })
  writeFileSync(join(draftsOf(rows[1]), REGISTRY_FILE), targetRegistry)
  const result = await location.choose('p2')
  expect(result.ok).toBe(false)
  expect(result.ok === false ? result.code : null).toBe('drafts_occupied')
  expect(data.get(DRAFTS_PROJECT_KEY)).toBe('p1')
  expect(await location.folder()).toBe(draftsOf(rows[0]))
  expectMovedTo(draftsOf(rows[0]))
  expect(readFileSync(join(draftsOf(rows[1]), REGISTRY_FILE), 'utf8')).toBe(targetRegistry)
  cleanup()
})

test('an empty target registry is not occupied', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  mkdirSync(draftsOf(rows[1]))
  writeFileSync(join(draftsOf(rows[1]), REGISTRY_FILE), '{"entries":{},"lastReturnTo":null}')
  const result = await location.choose('p2')
  expect(result.ok).toBe(true)
  expectMovedTo(draftsOf(rows[1]))
  const moved = JSON.parse(readFileSync(join(draftsOf(rows[1]), REGISTRY_FILE), 'utf8'))
  expect(Object.keys(moved.entries)).toEqual(['agents/a.yaml'])
  expect(existsSync(draftsOf(rows[0]))).toBe(false)
  cleanup()
})

test('takes over the legacy folder on the first choice', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const legacyFolder = join(tempDir(), 'legacy')
  populate(legacyFolder)
  const { location } = fakeLocation(rows, { legacyFolder })
  await location.choose('p1')
  expectMovedTo(draftsOf(rows[0]))
  expect(existsSync(legacyFolder)).toBe(false)
  // Un choix est retenu : le dossier historique n'est plus relu, même repeuplé.
  populate(legacyFolder)
  await location.choose('p2')
  expect(existsSync(join(draftsOf(rows[1]), REGISTRY_FILE))).toBe(true)
  expectMovedTo(draftsOf(rows[1]))
  expectMovedTo(legacyFolder)
  expect(readdirSync(legacyFolder).sort()).toEqual(['.gitignore', REGISTRY_FILE, 'agents', 'memories'].sort())
  cleanup()
})

test('the legacy folder stays untouched once a choice is stored', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const legacyFolder = join(tempDir(), 'legacy')
  const { location } = fakeLocation(rows, { legacyFolder })
  await location.choose('p1')
  populate(legacyFolder)
  await location.choose('p2')
  expectMovedTo(legacyFolder)
  expect(existsSync(join(draftsOf(rows[1]), REGISTRY_FILE))).toBe(false)
  cleanup()
})

test('falls back to copy when rename crosses devices', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const rename = async (): Promise<never> => {
    throw Object.assign(new Error('x'), { code: 'EXDEV' })
  }
  const { location } = fakeLocation(rows, { rename: rename as typeof import('node:fs/promises').rename })
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  const result = await location.choose('p2')
  expect(result.ok).toBe(true)
  expectMovedTo(draftsOf(rows[1]))
  expect(existsSync(draftsOf(rows[0]))).toBe(false)
  cleanup()
})

test('choosing the current project again moves nothing', async () => {
  const rows = [project('p1', 'one')]
  const { location } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  const result = await location.choose('p1')
  expect(result).toEqual({ ok: true, value: { folder: draftsOf(rows[0]) } })
  expectMovedTo(draftsOf(rows[0]))
  expect(readFileSync(join(draftsOf(rows[0]), 'agents', 'a.yaml'), 'utf8')).toBe('name: a\n')
  cleanup()
})

test('a missing source folder is not an error', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location, data } = fakeLocation(rows)
  await location.choose('p1')
  // Le dossier retenu a été supprimé à la main entre-temps.
  rmSync(draftsOf(rows[0]), { recursive: true })
  const result = await location.choose('p2')
  expect(result).toEqual({ ok: true, value: { folder: draftsOf(rows[1]) } })
  expect(data.get(DRAFTS_PROJECT_KEY)).toBe('p2')
  expect(existsSync(join(draftsOf(rows[1]), '.gitignore'))).toBe(true)
  cleanup()
})

test('a hidden chosen project is no longer current', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location } = fakeLocation(rows)
  await location.choose('p1')
  rows[0].hidden = true
  expect(await location.folder()).toBe(null)
  const listed = await location.projects()
  expect(listed.map((entry) => entry.id)).toEqual(['p2'])
  expect(listed.map((entry) => entry.current)).toEqual([false])
  cleanup()
})

test('a hidden chosen project still hands its drafts over', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  rows[0].hidden = true
  const result = await location.choose('p2')
  expect(result.ok).toBe(true)
  expectMovedTo(draftsOf(rows[1]))
  cleanup()
})

test('choose refuses an unknown project id', async () => {
  const rows = [project('p1', 'one'), project('p-hidden', 'hidden', { hidden: true }), project('p-ssh', 'ssh', { hostId: 'ssh:x' })]
  const { location, data } = fakeLocation(rows)
  for (const id of ['nope', 'p-hidden', 'p-ssh']) {
    const result = await location.choose(id)
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.code : null).toBe('invalid')
  }
  expect(data.has(DRAFTS_PROJECT_KEY)).toBe(false)
  expect(existsSync(draftsOf(rows[0]))).toBe(false)
  cleanup()
})

const NESTED_MESSAGE = 'The drafts folder cannot move inside itself. Choose another project.'

test('refuses a target nested in the source and touches nothing', async () => {
  // Un projet dont le chemin est le dossier de brouillons lui-même : la cible serait dedans.
  const rows = [project('p1', 'one')]
  const inside = project('p-inside', 'inside')
  rows.push(inside)
  const { location, data } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  inside.path = draftsOf(rows[0])
  const result = await location.choose('p-inside')
  expect(result).toEqual({ ok: false, error: NESTED_MESSAGE, code: 'invalid' })
  expect(data.get(DRAFTS_PROJECT_KEY)).toBe('p1')
  expectMovedTo(draftsOf(rows[0]))
  expect(existsSync(join(draftsOf(rows[0]), DRAFTS_SUBFOLDER))).toBe(false)
  expect(readFileSync(join(draftsOf(rows[0]), REGISTRY_FILE), 'utf8').includes('agents/a.yaml')).toBe(true)
  cleanup()
})

test('refuses a source nested in the target and touches nothing', async () => {
  // L'inverse : le dossier de brouillons retenu est dans celui du projet visé.
  const outer = project('p-outer', 'outer')
  const sub = project('p-sub', 'sub')
  sub.path = join(draftsOf(outer), 'sub')
  mkdirSync(sub.path, { recursive: true })
  const { location, data } = fakeLocation([outer, sub])
  await location.choose('p-sub')
  populate(draftsOf(sub))
  const result = await location.choose('p-outer')
  expect(result).toEqual({ ok: false, error: NESTED_MESSAGE, code: 'invalid' })
  expect(data.get(DRAFTS_PROJECT_KEY)).toBe('p-sub')
  expectMovedTo(draftsOf(sub))
  expect(existsSync(join(draftsOf(outer), REGISTRY_FILE))).toBe(false)
  cleanup()
})

test('refuses when a target file would be overwritten', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location, data } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  mkdirSync(join(draftsOf(rows[1]), 'agents'), { recursive: true })
  writeFileSync(join(draftsOf(rows[1]), 'agents', 'a.yaml'), 'target\n')
  const result = await location.choose('p2')
  expect(result.ok).toBe(false)
  expect(result.ok === false ? result.code : null).toBe('drafts_occupied')
  expect(readFileSync(join(draftsOf(rows[1]), 'agents', 'a.yaml'), 'utf8')).toBe('target\n')
  expect(readdirSync(join(draftsOf(rows[1]), 'agents'))).toEqual(['a.yaml'])
  expect(data.get(DRAFTS_PROJECT_KEY)).toBe('p1')
  expectMovedTo(draftsOf(rows[0]))
  cleanup()
})

test('merges directories of the target when no file collides', async () => {
  const rows = [project('p1', 'one'), project('p2', 'two')]
  const { location } = fakeLocation(rows)
  await location.choose('p1')
  populate(draftsOf(rows[0]))
  mkdirSync(join(draftsOf(rows[1]), 'agents'), { recursive: true })
  writeFileSync(join(draftsOf(rows[1]), 'agents', 'other.yaml'), 'other\n')
  const result = await location.choose('p2')
  expect(result.ok).toBe(true)
  expectMovedTo(draftsOf(rows[1]))
  expect(readFileSync(join(draftsOf(rows[1]), 'agents', 'other.yaml'), 'utf8')).toBe('other\n')
  cleanup()
})

test('draft handlers refuse without a chosen project', async () => {
  let called = false
  const result = await guardDrafts<string>(null, async () => {
    called = true
    return { ok: true, value: 'never' }
  })
  expect(result).toEqual({
    ok: false,
    error: 'Choose a drafts workspace in the Drafts section of the home first.',
    code: 'drafts_missing'
  })
  expect(called).toBe(false)
})

test('draft handlers delegate to the drafts object once a project is chosen', async () => {
  const drafts = { tag: 'fake' } as unknown as Drafts
  const seen: Drafts[] = []
  const result = await guardDrafts<string>(drafts, async (given) => {
    seen.push(given)
    return { ok: true, value: 'done' }
  })
  expect(result).toEqual({ ok: true, value: 'done' })
  expect(seen[0]).toBe(drafts)
})
