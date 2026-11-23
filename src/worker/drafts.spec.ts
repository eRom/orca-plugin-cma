import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiResult, DraftRef, PreparedWrite } from '../protocol'
import { REGISTRY_FILE, createDrafts, sameRef, slugify, type DraftAdapter, type DraftBase } from './drafts'
import type { EditorHost } from './editor-host'
import { fakeWorkspace } from './fake-workspace'
import { createPendingWrites } from './pending-writes'

type AgentRef = Extract<DraftRef, { kind: 'agent' }>

const LIVE = 'name: Live agent\n'
const AGENT: AgentRef = { kind: 'agent', agentId: 'agent_1' }
const FILE = 'agents/agent_1.yaml'

const dirs: string[] = []
function tempFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'cma-drafts-'))
  dirs.push(root)
  const folder = join(root, 'managed-agents')
  mkdirSync(folder)
  return folder
}

function cleanup(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Faux hôte : note les appels ; `folders` rend le chemin résolu, comme le fait Orca. */
function fakeHost(folder: string | null) {
  const calls: string[] = []
  const state = {
    focus: { workspaceId: 'ws-other', name: 'my-project' } as { workspaceId: string; name: string } | null,
    failShow: false
  }
  const host: EditorHost = {
    async folders() {
      return folder === null ? [] : [{ id: 'ws-drafts', name: 'managed-agents', path: realpathSync(folder) }]
    },
    async focused() {
      return state.focus
    },
    async show(workspaceId) {
      calls.push(`show ${workspaceId}`)
      if (state.failShow) {
        throw new Error('window unavailable')
      }
    },
    async open(workspaceId, path) {
      calls.push(`open ${workspaceId} ${path}`)
    }
  }
  return { host, calls, state }
}

function setup(options: { workspace?: boolean; adapters?: boolean; file?: (ref: AgentRef) => string } = {}) {
  const folder = tempFolder()
  const fake = fakeHost(options.workspace === false ? null : folder)
  const live = { text: LIVE, version: 3, reads: 0 }
  const prepared: { text: string; base: DraftBase }[] = []
  const logs: string[] = []
  const adapter: DraftAdapter<AgentRef> = {
    async file(ref) {
      return options.file ? options.file(ref) : `agents/${ref.agentId ?? 'new'}.yaml`
    },
    async readLive() {
      live.reads += 1
      return { text: live.text, base: { version: live.version } }
    },
    async prepare(_ref, text, base, stage): Promise<ApiResult<PreparedWrite>> {
      prepared.push({ text, base })
      return { ok: true, value: stage(async () => ({ ok: true, value: { label: 'Saved' } }), [], false) }
    }
  }
  const pending = createPendingWrites(() => 0)
  const clock = { at: new Date('2026-11-22T10:00:00.000Z') }
  const space = fakeWorkspace()
  const build = () =>
    createDrafts({
      folder,
      host: fake.host,
      adapters: options.adapters === false ? {} : { agent: adapter },
      workspace: space.deps,
      pending,
      now: () => clock.at,
      log: (message) => logs.push(message)
    })
  return { folder, fake, live, prepared, logs, drafts: build(), build, clock, space }
}

test('slugify lowercases, collapses separators, trims dashes and caps at 40 characters', () => {
  expect(slugify('Incident Commander!')).toBe('incident-commander')
  expect(slugify('--a  /  b--')).toBe('a-b')
  expect(slugify('')).toBe('item')
  expect(slugify('***')).toBe('item')
  expect(slugify('x'.repeat(60))).toBe('x'.repeat(40))
  // Le plafond ne laisse pas de tiret au bord.
  expect(slugify(`${'a'.repeat(39)}-bbb`)).toBe('a'.repeat(39))
})

test('status is not ready until a workspace holds the drafts folder', async () => {
  const { drafts, folder } = setup({ workspace: false })
  expect(await drafts.status()).toEqual({ folder, ready: false })
  cleanup()
})

test('status is ready once a workspace holds the folder, even when its path is a symlink target', async () => {
  const { drafts, folder } = setup()
  expect(await drafts.status()).toEqual({ folder, ready: true })
  cleanup()
})

test('open without a workspace for the folder is drafts_missing and writes no file', async () => {
  const { drafts, folder, live } = setup({ workspace: false })
  const result = await drafts.open(AGENT)
  expect(result).toEqual({ ok: false, code: 'drafts_missing', error: 'Add the drafts folder to Orca first.' })
  expect(existsSync(join(folder, FILE))).toBe(false)
  expect(live.reads).toBe(0)
  cleanup()
})

test('open writes the live text, then shows the drafts workspace and opens the file in it', async () => {
  const { drafts, folder, fake } = setup()
  const result = await drafts.open(AGENT)
  expect(result.ok).toBe(true)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe(LIVE)
  expect(fake.calls).toEqual(['show ws-drafts', `open ws-drafts ${FILE}`])
  if (result.ok) {
    expect(result.value.file).toBe(FILE)
    expect(result.value.ref).toEqual(AGENT)
    expect(result.value.unapplied).toBe(false)
    expect(result.value.writtenAt).toBe('2026-11-22T10:00:00.000Z')
  }
  cleanup()
})

test('open keeps an unapplied draft untouched and does not read the live object', async () => {
  const { drafts, folder, live } = setup()
  await drafts.open(AGENT)
  expect(live.reads).toBe(1)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  live.text = 'name: Changed elsewhere\n'
  const result = await drafts.open(AGENT)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: My edit\n')
  expect(live.reads).toBe(1)
  expect(result.ok && result.value.unapplied).toBe(true)
  cleanup()
})

test('open refreshes a draft the user never changed from the live object', async () => {
  const { drafts, folder, live } = setup()
  await drafts.open(AGENT)
  live.text = 'name: Changed elsewhere\n'
  const result = await drafts.open(AGENT)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: Changed elsewhere\n')
  expect(live.reads).toBe(2)
  expect(result.ok && result.value.unapplied).toBe(false)
  cleanup()
})

test('open reports the save time of the file as savedAt', async () => {
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  const result = await drafts.open(AGENT)
  const mtime = statSync(join(folder, FILE)).mtime.toISOString()
  expect(result.ok && result.value.savedAt).toBe(mtime)
  cleanup()
})

test('returnTo is the focused workspace', async () => {
  const { drafts } = setup()
  const result = await drafts.open(AGENT)
  expect(result.ok && result.value.returnTo).toEqual({ workspaceId: 'ws-other', name: 'my-project' })
  cleanup()
})

test('returnTo is null when the focused workspace is the drafts workspace and there is no earlier one', async () => {
  const { drafts, fake } = setup()
  fake.state.focus = { workspaceId: 'ws-drafts', name: 'managed-agents' }
  const result = await drafts.open(AGENT)
  expect(result.ok && result.value.returnTo).toBe(null)
  cleanup()
})

test('returnTo is null when nothing is focused', async () => {
  const { drafts, fake } = setup()
  fake.state.focus = null
  const result = await drafts.open(AGENT)
  expect(result.ok && result.value.returnTo).toBe(null)
  cleanup()
})

test('open fails readably when the host refuses to show the workspace', async () => {
  const { drafts, fake } = setup()
  fake.state.failShow = true
  const result = await drafts.open(AGENT)
  expect(result).toEqual({ ok: false, code: 'other', error: 'Orca could not open the draft: window unavailable' })
  cleanup()
})

test('open rejects a file path that escapes the drafts folder', async () => {
  const { folder } = setup()
  const escaping: DraftAdapter<AgentRef> = {
    async file() {
      return '../outside.yaml'
    },
    async readLive() {
      return { text: 'x', base: null }
    },
    async prepare() {
      throw new Error('unreachable')
    }
  }
  const fake = fakeHost(folder)
  const drafts = createDrafts({ folder, host: fake.host, adapters: { agent: escaping }, workspace: fakeWorkspace().deps, pending: createPendingWrites(() => 0), now: () => new Date(), log: () => {} })
  const result = await drafts.open(AGENT)
  expect(result).toEqual({ ok: false, code: 'other', error: 'The draft path is outside the drafts folder.' })
  expect(fake.calls).toEqual([])
  cleanup()
})

test('prepare without any change since the write is nothing_to_apply', async () => {
  const { drafts, prepared } = setup()
  await drafts.open(AGENT)
  const result = await drafts.prepare(AGENT)
  expect(result).toEqual({ ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: save the file first (⌘S).' })
  expect(prepared.length).toBe(0)
  cleanup()
})

test('prepare hands the saved text and the recorded base to the adapter', async () => {
  const { drafts, folder, prepared } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  const result = await drafts.prepare(AGENT)
  expect(result.ok).toBe(true)
  expect(prepared).toEqual([{ text: 'name: My edit\n', base: { version: 3 } }])
  cleanup()
})

test('prepare without a registry entry says the file is gone', async () => {
  const { drafts } = setup()
  expect(await drafts.prepare(AGENT)).toEqual({ ok: false, code: 'other', error: 'The draft file is gone: open it again.' })
  cleanup()
})

test('prepare after the file was deleted says the file is gone', async () => {
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  rmSync(join(folder, FILE))
  expect(await drafts.prepare(AGENT)).toEqual({ ok: false, code: 'other', error: 'The draft file is gone: open it again.' })
  cleanup()
})

test('a new Drafts on the same folder reads the registry back: an edited draft stays unapplied', async () => {
  const { drafts, build, folder, live } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: Edited before restart\n')
  const restarted = build()
  const state = await restarted.state(AGENT)
  expect(state.ok && state.value?.unapplied).toBe(true)
  const reopened = await restarted.open(AGENT)
  expect(reopened.ok && reopened.value.unapplied).toBe(true)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: Edited before restart\n')
  expect(live.reads).toBe(1)
  cleanup()
})

test('state is null for a draft that was never opened and false-unapplied for a fresh one', async () => {
  const { drafts } = setup()
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  await drafts.open(AGENT)
  const state = await drafts.state(AGENT)
  expect(state.ok && state.value?.unapplied).toBe(false)
  cleanup()
})

test('state is null once the file was deleted', async () => {
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  rmSync(join(folder, FILE))
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  cleanup()
})

test('discard rewrites the file from the live object and the draft is no longer unapplied', async () => {
  const { drafts, folder, live } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  live.text = 'name: Live again\n'
  const result = await drafts.discard(AGENT)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: Live again\n')
  expect(result.ok && result.value.unapplied).toBe(false)
  const state = await drafts.state(AGENT)
  expect(state.ok && state.value?.unapplied).toBe(false)
  cleanup()
})

test('rewrite replaces the file and the registry base after a successful send', async () => {
  const { drafts, folder, prepared } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  expect(await drafts.rewrite(AGENT, 'name: Saved version\n', { version: 4 }, 'name: My edit\n')).toBe(true)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: Saved version\n')
  const state = await drafts.state(AGENT)
  expect(state.ok && state.value?.unapplied).toBe(false)
  writeFileSync(join(folder, FILE), 'name: Next edit\n')
  await drafts.prepare(AGENT)
  expect(prepared).toEqual([{ text: 'name: Next edit\n', base: { version: 4 } }])
  cleanup()
})

test('a kind without an adapter answers Not available yet', async () => {
  const { drafts } = setup({ adapters: false })
  const unavailable = { ok: false, code: 'other', error: 'Not available yet.' }
  expect(await drafts.open(AGENT)).toEqual(unavailable)
  expect(await drafts.state(AGENT)).toEqual(unavailable)
  expect(await drafts.prepare(AGENT)).toEqual(unavailable)
  expect(await drafts.discard(AGENT)).toEqual(unavailable)
  cleanup()
})

test('files are written through a temporary file: no leftover next to the draft or the registry', async () => {
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  expect(readdirSync(join(folder, 'agents'))).toEqual(['agent_1.yaml'])
  expect(readdirSync(folder).sort()).toEqual([REGISTRY_FILE, 'agents'])
  cleanup()
})

test('back shows the workspace and reports a refusal readably', async () => {
  const { drafts, fake } = setup()
  expect(await drafts.back('ws-other')).toEqual({ ok: true, value: null })
  expect(fake.calls).toEqual(['show ws-other'])
  fake.state.failShow = true
  expect(await drafts.back('ws-other')).toEqual({ ok: false, code: 'other', error: 'Orca could not switch back: window unavailable' })
  cleanup()
})

test('two simultaneous opens of the same draft keep a consistent registry', async () => {
  const { drafts, folder } = setup()
  const [first, second] = await Promise.all([drafts.open(AGENT), drafts.open(AGENT)])
  expect(first.ok && second.ok).toBe(true)
  const registry = JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8'))
  expect(Object.keys(registry.entries)).toEqual([FILE])
  cleanup()
})

const listDir = (path: string): string[] => readdirSync(path).sort()

test('open sets aside a file that has no registry entry and differs from the live object', async () => {
  const { drafts, folder, logs } = setup()
  mkdirSync(join(folder, 'agents'))
  writeFileSync(join(folder, FILE), 'name: Orphan edit\n')
  const result = await drafts.open(AGENT)
  expect(result.ok).toBe(true)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe(LIVE)
  const recovered = listDir(join(folder, 'agents')).filter((name) => name.startsWith('agent_1.yaml.recovered-'))
  expect(recovered.length).toBe(1)
  expect(readFileSync(join(folder, 'agents', recovered[0]), 'utf8')).toBe('name: Orphan edit\n')
  expect(logs.some((line) => line.includes('recovered-'))).toBe(true)
  cleanup()
})

test('open keeps no copy of an unregistered file that already equals the live object', async () => {
  const { drafts, folder } = setup()
  mkdirSync(join(folder, 'agents'))
  writeFileSync(join(folder, FILE), LIVE)
  await drafts.open(AGENT)
  expect(listDir(join(folder, 'agents'))).toEqual(['agent_1.yaml'])
  cleanup()
})

test('an unreadable registry is moved aside, not discarded, and the draft opens', async () => {
  const { drafts, folder, logs } = setup()
  writeFileSync(join(folder, REGISTRY_FILE), '{ not json')
  const result = await drafts.open(AGENT)
  expect(result.ok).toBe(true)
  const aside = listDir(folder).filter((name) => name.startsWith(`${REGISTRY_FILE}.corrupt-`))
  expect(aside.length).toBe(1)
  expect(readFileSync(join(folder, aside[0]), 'utf8')).toBe('{ not json')
  expect(logs.some((line) => line.includes('corrupt-'))).toBe(true)
  const registry = JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8'))
  expect(Object.keys(registry.entries)).toEqual([FILE])
  cleanup()
})

test('two refs that map to one file never share an edit or a base', async () => {
  const other: AgentRef = { kind: 'agent', agentId: 'agent_2' }
  const shared = 'agents/shared.yaml'
  const { drafts, folder, prepared } = setup({ file: () => shared })
  await drafts.open(AGENT)
  writeFileSync(join(folder, shared), 'name: Edit of the first\n')
  const refused = { ok: false, code: 'other', error: 'Another draft already uses this file name.' }
  expect(await drafts.open(other)).toEqual(refused)
  expect(await drafts.state(other)).toEqual({ ok: true, value: null })
  expect(await drafts.prepare(other)).toEqual({ ok: false, code: 'other', error: 'The draft file is gone: open it again.' })
  expect(await drafts.discard(other)).toEqual(refused)
  expect(prepared.length).toBe(0)
  expect(readFileSync(join(folder, shared), 'utf8')).toBe('name: Edit of the first\n')
  const first = await drafts.state(AGENT)
  expect(first.ok && first.value?.unapplied).toBe(true)
  cleanup()
})

test('rewrite keeps the newer edits of the user and leaves the draft unapplied', async () => {
  const { drafts, folder, prepared } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: Newer edit\n')
  expect(await drafts.rewrite(AGENT, 'name: Saved version\n', { version: 4 }, 'name: Sent edit\n')).toBe(true)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: Newer edit\n')
  const state = await drafts.state(AGENT)
  expect(state.ok && state.value?.unapplied).toBe(true)
  await drafts.prepare(AGENT)
  expect(prepared).toEqual([{ text: 'name: Newer edit\n', base: { version: 4 } }])
  cleanup()
})

test('rewrite does not reject when the disk refuses: it answers false and logs', async () => {
  const { drafts, folder, logs } = setup()
  await drafts.open(AGENT)
  // Un fichier à la place du dossier `agents` : toute lecture ou écriture dessous échoue.
  rmSync(join(folder, 'agents'), { recursive: true })
  writeFileSync(join(folder, 'agents'), 'not a directory')
  expect(await drafts.rewrite(AGENT, 'name: Saved version\n', { version: 4 }, LIVE)).toBe(false)
  expect(logs.some((line) => line.includes('rewrite failed'))).toBe(true)
  cleanup()
})

test('returnTo falls back to the previous one when a draft is reopened from the drafts workspace', async () => {
  const { drafts, fake } = setup()
  await drafts.open(AGENT)
  fake.state.focus = { workspaceId: 'ws-drafts', name: 'managed-agents' }
  const again = await drafts.open(AGENT)
  expect(again.ok && again.value.returnTo).toEqual({ workspaceId: 'ws-other', name: 'my-project' })
  cleanup()
})

test('returnTo of a first draft opened from the drafts workspace is the last working workspace seen', async () => {
  const second: AgentRef = { kind: 'agent', agentId: 'agent_2' }
  const { drafts, fake } = setup()
  await drafts.open(AGENT)
  fake.state.focus = { workspaceId: 'ws-drafts', name: 'managed-agents' }
  const result = await drafts.open(second)
  expect(result.ok && result.value.returnTo).toEqual({ workspaceId: 'ws-other', name: 'my-project' })
  cleanup()
})

test('a draft path is normalised and the registry, its copies and temporary files are reserved', async () => {
  const names = { value: 'agents/../notes/x.yaml' }
  const { drafts, fake } = setup({ file: () => names.value })
  const opened = await drafts.open(AGENT)
  expect(opened.ok && opened.value.file).toBe('notes/x.yaml')
  expect(fake.calls).toEqual(['show ws-drafts', 'open ws-drafts notes/x.yaml'])
  for (const reserved of [REGISTRY_FILE, `${REGISTRY_FILE}.corrupt-2026`, 'agents/x.tmp']) {
    names.value = reserved
    expect(await drafts.open(AGENT)).toEqual({ ok: false, code: 'other', error: 'This draft file name is reserved.' })
  }
  expect(fake.calls.length).toBe(2)
  cleanup()
})

test('a recovery copy name is reserved too: a path with the .recovered- infix never opens or overwrites a rescue copy', async () => {
  const names = { value: 'agents/x.yaml.recovered-2026-11-22T10-00-00-000Z' }
  const { drafts, fake } = setup({ file: () => names.value })
  for (const reserved of [names.value, 'notes/x.recovered-1/y.yaml', 'notes/x.recovered-1.yaml']) {
    names.value = reserved
    expect(await drafts.open(AGENT)).toEqual({ ok: false, code: 'other', error: 'This draft file name is reserved.' })
    expect(await drafts.discard(AGENT)).toEqual({ ok: false, code: 'other', error: 'This draft file name is reserved.' })
  }
  expect(fake.calls).toEqual([])
  cleanup()
})

test('an adapter check refuses a ref as invalid before any file or live read, on every entry point', async () => {
  const folder = tempFolder()
  const fake = fakeHost(folder)
  const reads = { count: 0 }
  const checked: DraftAdapter<AgentRef> = {
    check: () => 'Nope.',
    async file() {
      return 'agents/x.yaml'
    },
    async readLive() {
      reads.count += 1
      return { text: 'x', base: null }
    },
    async prepare() {
      throw new Error('unreachable')
    }
  }
  const drafts = createDrafts({ folder, host: fake.host, adapters: { agent: checked }, workspace: fakeWorkspace().deps, pending: createPendingWrites(() => 0), now: () => new Date(), log: () => {} })
  const refused = { ok: false, code: 'invalid', error: 'Nope.' }
  expect(await drafts.open(AGENT)).toEqual(refused)
  expect(await drafts.state(AGENT)).toEqual(refused)
  expect(await drafts.prepare(AGENT)).toEqual(refused)
  expect(await drafts.discard(AGENT)).toEqual(refused)
  expect(await drafts.rewrite(AGENT, 'x', null, 'x')).toBe(false)
  expect(reads.count).toBe(0)
  expect(readdirSync(folder)).toEqual([])
  cleanup()
})

test('find lists the registered drafts a predicate keeps, with their file and unapplied state, and never writes', async () => {
  const second: AgentRef = { kind: 'agent', agentId: 'agent_2' }
  const { drafts, folder } = setup()
  expect(await drafts.find(() => true)).toEqual([])
  await drafts.open(AGENT)
  await drafts.open(second)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  const registryBefore = readFileSync(join(folder, REGISTRY_FILE), 'utf8')
  const found = await drafts.find((ref) => ref.kind === 'agent' && ref.agentId === 'agent_1')
  expect(found).toEqual([{ ref: AGENT, file: FILE, unapplied: true }])
  const all = await drafts.find(() => true)
  expect(all.map((entry) => [entry.file, entry.unapplied])).toEqual([
    [FILE, true],
    ['agents/agent_2.yaml', false]
  ])
  expect(readFileSync(join(folder, REGISTRY_FILE), 'utf8')).toBe(registryBefore)
  // Un fichier disparu n'est pas un brouillon non appliqué : rien n'y bloquerait plus personne.
  rmSync(join(folder, FILE))
  expect((await drafts.find((ref) => ref.kind === 'agent' && ref.agentId === 'agent_1'))[0]?.unapplied).toBe(false)
  cleanup()
})

test('find from inside an adapter does not deadlock the draft queue, and ignores an unreadable registry', async () => {
  const folder = tempFolder()
  const fake = fakeHost(folder)
  const seen: number[] = []
  const holder: { drafts?: ReturnType<typeof createDrafts> } = {}
  const probing: DraftAdapter<AgentRef> = {
    async file(ref) {
      seen.push((await holder.drafts!.find(() => true)).length)
      return `agents/${ref.agentId}.yaml`
    },
    async readLive() {
      return { text: 'x', base: null }
    },
    async prepare() {
      throw new Error('unreachable')
    }
  }
  holder.drafts = createDrafts({ folder, host: fake.host, adapters: { agent: probing }, workspace: fakeWorkspace().deps, pending: createPendingWrites(() => 0), now: () => new Date(), log: () => {} })
  expect((await holder.drafts.open(AGENT)).ok).toBe(true)
  writeFileSync(join(folder, REGISTRY_FILE), '{ not json')
  expect(await holder.drafts.find(() => true)).toEqual([])
  // La lecture seule ne met rien de côté : le registre abîmé est encore là pour la prochaine opération.
  expect(readFileSync(join(folder, REGISTRY_FILE), 'utf8')).toBe('{ not json')
  expect(seen).toEqual([0])
  cleanup()
})

test('sameRef compares memories by id when both have one, and by path otherwise', () => {
  const base = { kind: 'memory' as const, memoryStoreId: 'memstore_1' }
  // Deux ids : le chemin peut avoir changé (renommage), l'identité reste.
  expect(sameRef({ ...base, memoryId: 'mem_1', path: '/a.md' }, { ...base, memoryId: 'mem_1', path: '/b.md' })).toBe(true)
  expect(sameRef({ ...base, memoryId: 'mem_1', path: '/a.md' }, { ...base, memoryId: 'mem_2', path: '/a.md' })).toBe(false)
  // Une création et la mémoire qu'elle a créée : même chemin, l'un sans id.
  expect(sameRef({ ...base, memoryId: null, path: '/a.md' }, { ...base, memoryId: 'mem_1', path: '/a.md' })).toBe(true)
  expect(sameRef({ ...base, memoryId: 'mem_1', path: '/a.md' }, { ...base, memoryId: null, path: '/a.md' })).toBe(true)
  expect(sameRef({ ...base, memoryId: null, path: '/a.md' }, { ...base, memoryId: 'mem_1', path: '/b.md' })).toBe(false)
  expect(sameRef({ ...base, memoryId: null, path: '/a.md' }, { ...base, memoryId: null, path: '/a.md' })).toBe(true)
  expect(sameRef({ ...base, memoryId: null, path: '/a.md' }, { ...base, memoryStoreId: 'memstore_2', memoryId: null, path: '/a.md' })).toBe(false)
  expect(sameRef(AGENT, { kind: 'agent', agentId: 'agent_1' })).toBe(true)
  expect(sameRef(AGENT, { kind: 'agent', agentId: 'agent_2' })).toBe(false)
  expect(sameRef(AGENT, { ...base, memoryId: null, path: '/a.md' })).toBe(false)
})

test('two refs whose files differ only by case never share a file: macOS folds the case, so the second is refused', async () => {
  const second: AgentRef = { kind: 'agent', agentId: 'agent_2' }
  const { drafts, folder, prepared } = setup({ file: (ref) => (ref.agentId === 'agent_1' ? 'agents/Draft.yaml' : 'agents/draft.yaml') })
  await drafts.open(AGENT)
  writeFileSync(join(folder, 'agents/Draft.yaml'), 'name: My unsent edit\n')
  const refused = { ok: false, code: 'other', error: 'Another draft already uses this file name.' }
  expect(await drafts.open(second)).toEqual(refused)
  expect(await drafts.discard(second)).toEqual(refused)
  expect(await drafts.rewrite(second, 'name: Other\n', null, 'name: Other\n')).toBe(false)
  expect(await drafts.prepare(second)).toEqual({ ok: false, code: 'other', error: 'The draft file is gone: open it again.' })
  expect(prepared.length).toBe(0)
  expect(readFileSync(join(folder, 'agents/Draft.yaml'), 'utf8')).toBe('name: My unsent edit\n')
  expect(readdirSync(join(folder, 'agents'))).toEqual(['Draft.yaml'])
  const first = await drafts.state(AGENT)
  expect(first.ok && first.value?.unapplied).toBe(true)
  cleanup()
})

test('the same ref keeps working on its original file name when the adapter answers another case', async () => {
  const names = { value: 'agents/Draft.yaml' }
  const { drafts, folder } = setup({ file: () => names.value })
  await drafts.open(AGENT)
  names.value = 'agents/draft.yaml'
  const again = await drafts.open(AGENT)
  expect(again.ok && again.value.file).toBe('agents/Draft.yaml')
  expect(Object.keys(JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8')).entries)).toEqual(['agents/Draft.yaml'])
  cleanup()
})

test('state answers null without asking the adapter for a file when no registered draft matches', async () => {
  const folder = tempFolder()
  const fake = fakeHost(folder)
  const asked = { count: 0 }
  const offline: DraftAdapter<AgentRef> = {
    async file() {
      asked.count += 1
      throw new Error('offline')
    },
    async readLive() {
      throw new Error('offline')
    },
    async prepare() {
      throw new Error('unreachable')
    }
  }
  const drafts = createDrafts({ folder, host: fake.host, adapters: { agent: offline }, workspace: fakeWorkspace().deps, pending: createPendingWrites(() => 0), now: () => new Date(), log: () => {} })
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  expect(asked.count).toBe(0)
  cleanup()
})

test('release drops the clean drafts a predicate keeps, with their files, and never an unapplied one', async () => {
  const second: AgentRef = { kind: 'agent', agentId: 'agent_2' }
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  await drafts.open(second)
  writeFileSync(join(folder, 'agents/agent_2.yaml'), 'name: Unsent\n')
  const result = await drafts.release(() => true)
  expect(result).toEqual({ released: [FILE], kept: ['agents/agent_2.yaml'] })
  expect(existsSync(join(folder, FILE))).toBe(false)
  expect(readFileSync(join(folder, 'agents/agent_2.yaml'), 'utf8')).toBe('name: Unsent\n')
  expect(Object.keys(JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8')).entries)).toEqual(['agents/agent_2.yaml'])
  cleanup()
})

test('a clean draft gives its file name to another draft, an unapplied one keeps it', async () => {
  const other: AgentRef = { kind: 'agent', agentId: 'agent_other' }
  const { drafts, folder } = setup({ file: () => 'agents/shared.yaml' })
  await drafts.open(AGENT)
  writeFileSync(join(folder, 'agents/shared.yaml'), 'name: Unsent\n')
  expect((await drafts.open(other)).ok).toBe(false)
  // Le travail de Romain n'est jamais écrasé, même par un brouillon qui se présente avec la même référence de fichier.
  expect(readFileSync(join(folder, 'agents/shared.yaml'), 'utf8')).toBe('name: Unsent\n')
  await drafts.discard(AGENT)
  const taken = await drafts.open(other)
  expect(taken.ok).toBe(true)
  const entries = JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8')).entries
  expect(entries['agents/shared.yaml'].ref).toEqual(other)
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  cleanup()
})

test('a draft whose file vanished is clean: another draft takes its file name', async () => {
  const other: AgentRef = { kind: 'agent', agentId: 'agent_other' }
  const { drafts, folder } = setup({ file: () => 'agents/shared.yaml' })
  await drafts.open(AGENT)
  rmSync(join(folder, 'agents/shared.yaml'))
  expect((await drafts.open(other)).ok).toBe(true)
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  cleanup()
})

test('release with a replacement keeps an unapplied draft under the reference the replacement gives, with no base', async () => {
  const second: AgentRef = { kind: 'agent', agentId: 'agent_2' }
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  await drafts.open(second)
  writeFileSync(join(folder, 'agents/agent_2.yaml'), 'name: Unsent\n')
  const renamed: AgentRef = { kind: 'agent', agentId: 'agent_new' }
  const result = await drafts.release(() => true, () => renamed)
  expect(result).toEqual({ released: [FILE], kept: ['agents/agent_2.yaml'] })
  const entry = JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8')).entries['agents/agent_2.yaml']
  expect(entry.ref).toEqual(renamed)
  expect(entry.base).toBe(null)
  expect(readFileSync(join(folder, 'agents/agent_2.yaml'), 'utf8')).toBe('name: Unsent\n')
  cleanup()
})

test('release of a draft whose file is already gone still drops its entry', async () => {
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  rmSync(join(folder, FILE))
  expect(await drafts.release(() => true)).toEqual({ released: [FILE], kept: [] })
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  cleanup()
})

// Brouillons et workspaces : chaque brouillon appartient au workspace où il a été ouvert (`localId`).
const SECOND: AgentRef = { kind: 'agent', agentId: 'agent_2' }
const registryOf = (folder: string) =>
  JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8')) as { entries: Record<string, { workspace?: string; ref: DraftRef }> }

test('a draft opened under A is stamped with A', async () => {
  const { drafts, folder } = setup()
  await drafts.open(AGENT)
  expect(registryOf(folder).entries[FILE]?.workspace).toBe('ws-a')
  cleanup()
})

test('state hides a draft of another workspace', async () => {
  const { drafts, folder, space } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  space.state.active = 'ws-b'
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  space.state.active = 'ws-a'
  const back = await drafts.state(AGENT)
  expect(back.ok && back.value?.file).toBe(FILE)
  expect(back.ok && back.value?.unapplied).toBe(true)
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: My edit\n')
  cleanup()
})

test('prepare refuses a draft of another workspace without calling the API', async () => {
  const { drafts, folder, prepared, space } = setup()
  space.state.names['ws-a'] = 'Orca-claude'
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  space.state.active = 'ws-b'
  expect(await drafts.prepare(AGENT)).toEqual({
    ok: false,
    code: 'other',
    error: 'This draft belongs to Orca-claude. Switch to it to apply.'
  })
  expect(prepared.length).toBe(0)
  space.state.active = 'ws-a'
  expect((await drafts.prepare(AGENT)).ok).toBe(true)
  expect(prepared.length).toBe(1)
  cleanup()
})

test('prepare says a draft belongs to a removed workspace when its name is unknown', async () => {
  const { drafts, folder, prepared, space } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  delete space.state.names['ws-a']
  space.state.active = 'ws-b'
  expect(await drafts.prepare(AGENT)).toEqual({ ok: false, code: 'other', error: 'This draft belongs to a workspace that was removed.' })
  expect(prepared.length).toBe(0)
  cleanup()
})

test('a registry entry without workspace belongs to the migrated workspace', async () => {
  const { drafts, folder, build, space } = setup()
  await drafts.open(AGENT)
  const registry = registryOf(folder)
  delete registry.entries[FILE]?.workspace
  writeFileSync(join(folder, REGISTRY_FILE), JSON.stringify(registry))
  space.state.legacy = 'ws-b'
  space.state.active = 'ws-a'
  expect(await build().state(AGENT)).toEqual({ ok: true, value: null })
  space.state.active = 'ws-b'
  const state = await build().state(AGENT)
  expect(state.ok && state.value?.file).toBe(FILE)
  cleanup()
})

test('discard of a draft of another workspace says so and leaves its file untouched', async () => {
  const { drafts, folder, live, space } = setup()
  await drafts.open(AGENT)
  writeFileSync(join(folder, FILE), 'name: My edit\n')
  space.state.active = 'ws-b'
  live.text = 'name: Live again\n'
  expect(await drafts.discard(AGENT)).toEqual({ ok: false, code: 'other', error: 'This draft belongs to Default. Switch to it to discard.' })
  expect(readFileSync(join(folder, FILE), 'utf8')).toBe('name: My edit\n')
  expect(registryOf(folder).entries[FILE]?.workspace).toBe('ws-a')
  cleanup()
})

test('release and find only see the drafts of the active workspace', async () => {
  const { drafts, folder, space } = setup()
  await drafts.open(AGENT)
  space.state.active = 'ws-b'
  await drafts.open(SECOND)
  expect((await drafts.find(() => true)).map((found) => found.file)).toEqual(['agents/agent_2.yaml'])
  expect(await drafts.release(() => true)).toEqual({ released: ['agents/agent_2.yaml'], kept: [] })
  // Le brouillon propre de A reste, fichier et entrée : B n'y touche pas.
  expect(existsSync(join(folder, FILE))).toBe(true)
  expect(Object.keys(registryOf(folder).entries)).toEqual([FILE])
  space.state.active = 'ws-a'
  expect((await drafts.find(() => true)).map((found) => found.file)).toEqual([FILE])
  cleanup()
})

test('a clean draft of another workspace is never replaced by a draft that wants its file name', async () => {
  const other: AgentRef = { kind: 'agent', agentId: 'agent_other' }
  const { drafts, folder, space } = setup({ file: () => 'agents/shared.yaml' })
  await drafts.open(AGENT)
  space.state.active = 'ws-b'
  expect(await drafts.open(other)).toEqual({ ok: false, code: 'other', error: 'Another draft already uses this file name.' })
  expect(existsSync(join(folder, 'agents/shared.yaml'))).toBe(true)
  expect(registryOf(folder).entries['agents/shared.yaml']?.workspace).toBe('ws-a')
  cleanup()
})

test('without an active workspace, open, discard and prepare answer as without a key and state answers null', async () => {
  const { drafts, folder, live, space } = setup()
  await drafts.open(AGENT)
  space.state.active = null
  const noKey = { ok: false, code: 'no_key', error: 'Add your Anthropic API key first.' }
  expect(await drafts.open(AGENT)).toEqual(noKey)
  expect(await drafts.discard(AGENT)).toEqual(noKey)
  expect(await drafts.prepare(AGENT)).toEqual(noKey)
  expect(await drafts.state(AGENT)).toEqual({ ok: true, value: null })
  expect(await drafts.find(() => true)).toEqual([])
  expect(live.reads).toBe(1)
  expect(existsSync(join(folder, FILE))).toBe(true)
  cleanup()
})
