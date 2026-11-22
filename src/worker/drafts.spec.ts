import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiResult, DraftRef, PreparedWrite } from '../protocol'
import { REGISTRY_FILE, createDrafts, slugify, type DraftAdapter, type DraftBase } from './drafts'
import type { EditorHost } from './editor-host'
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
  const build = () =>
    createDrafts({
      folder,
      host: fake.host,
      adapters: options.adapters === false ? {} : { agent: adapter },
      pending,
      now: () => clock.at,
      log: (message) => logs.push(message)
    })
  return { folder, fake, live, prepared, logs, drafts: build(), build, clock }
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
  const drafts = createDrafts({ folder, host: fake.host, adapters: { agent: escaping }, pending: createPendingWrites(() => 0), now: () => new Date(), log: () => {} })
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
