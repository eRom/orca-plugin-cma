import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DraftRef } from '../protocol'
import { INVALID_MEMORY_PATH, isSafeMemoryPath } from '../shared/memory-path'
import { CONFLICT_MESSAGE, type ClientStore } from './client'
import { REGISTRY_FILE, createDrafts, type Drafts } from './drafts'
import type { EditorHost } from './editor-host'
import { createMemoryAdapter, createMemoryRename, memoryFile } from './memory-drafts'
import { createPendingWrites } from './pending-writes'

type MemoryRef = Extract<DraftRef, { kind: 'memory' }>

const EXISTING: MemoryRef = { kind: 'memory', memoryStoreId: 'memstore_1', memoryId: 'mem_1', path: '/notes/a.md' }
const NEW: MemoryRef = { kind: 'memory', memoryStoreId: 'memstore_1', memoryId: null, path: '/notes/new.md' }
const EXISTING_FILE = 'memories/notes--memstore_1/notes/a.md'
const NEW_FILE = 'memories/notes--memstore_1/notes/new.md'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

// Les caractères invisibles se construisent : un échappement tapé dans un fichier se retrouverait en clair, invisible.
const char = (code: number): string => String.fromCharCode(code)

test('isSafeMemoryPath accepts a rooted path and refuses every unsafe shape', () => {
  for (const good of ['/notes/long.md', '/SOULD.md', '/a', `/${'x/'.repeat(19)}y`, '/notes/été.md']) {
    expect(isSafeMemoryPath(good)).toBe(true)
  }
  const refused = [
    'notes.md',
    '',
    '/',
    '/a/',
    '/a/../b',
    '/a/./b',
    '/a//b',
    '/../../.ssh/id',
    '/a\\b',
    `/${'x'.repeat(1024)}`
  ]
  for (const bad of refused) {
    expect(isSafeMemoryPath(bad)).toBe(false)
  }
})

test('isSafeMemoryPath applies the API rules: 20 segments, NFC, no control or separator characters, 255 bytes per segment', () => {
  expect(isSafeMemoryPath(`/${'x/'.repeat(20)}y`)).toBe(false)
  expect(isSafeMemoryPath(`/a${char(7)}b`)).toBe(false)
  expect(isSafeMemoryPath(`/a${char(0)}b`)).toBe(false)
  expect(isSafeMemoryPath(`/a${char(0x7f)}b`)).toBe(false)
  expect(isSafeMemoryPath(`/a${char(0x2028)}b`)).toBe(false)
  expect(isSafeMemoryPath(`/a${char(0x2029)}b`)).toBe(false)
  // Un caractère de format (espace de largeur nulle) est refusé par l'API.
  expect(isSafeMemoryPath(`/a${char(0x200b)}b`)).toBe(false)
  // « é » décomposé (e + accent combinant) n'est pas en forme NFC.
  expect(isSafeMemoryPath(`/e${char(0x301)}.md`)).toBe(false)
  expect(isSafeMemoryPath('/é.md')).toBe(true)
  expect(isSafeMemoryPath(`/${'x'.repeat(255)}`)).toBe(true)
  expect(isSafeMemoryPath(`/${'x'.repeat(256)}`)).toBe(false)
  // 255 octets, pas 255 caractères : 128 « é » font 256 octets.
  expect(isSafeMemoryPath(`/${'é'.repeat(127)}`)).toBe(true)
  expect(isSafeMemoryPath(`/${'é'.repeat(128)}`)).toBe(false)
  // Le plafond de 1 024 octets du chemin entier, des segments eux-mêmes admis : 1 024 passe, 1 026 non.
  const wide = Array.from({ length: 4 }, () => 'x'.repeat(255)).join('/')
  expect(isSafeMemoryPath(`/${wide}`)).toBe(true)
  expect(isSafeMemoryPath(`/${wide}/a`)).toBe(false)
  expect(INVALID_MEMORY_PATH).toBe('A memory path starts with / and has no . or .. segments.')
})

test('memoryFile names the store folder by slug and id and keeps the memory path', () => {
  expect(memoryFile('orca-memory-001', 'memstore_1', '/notes/a.md')).toBe('memories/orca-memory-001--memstore_1/notes/a.md')
  expect(memoryFile('Notes & Co!', 'memstore_2', '/SOULD.md')).toBe('memories/notes-co--memstore_2/SOULD.md')
})

const dirs: string[] = []
function tempFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'cma-memory-drafts-'))
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

function fakeHost(folder: string): { host: EditorHost; calls: string[] } {
  const calls: string[] = []
  const host: EditorHost = {
    async folders() {
      return [{ id: 'ws-drafts', name: 'managed-agents', path: realpathSync(folder) }]
    },
    async focused() {
      return { workspaceId: 'ws-other', name: 'my-project' }
    },
    async show(workspaceId) {
      calls.push(`show ${workspaceId}`)
    },
    async open(workspaceId, path) {
      calls.push(`open ${workspaceId} ${path}`)
    }
  }
  return { host, calls }
}

type Call = { method: string; args: unknown[] }
type Stored = { path: string; content: string; sha?: string }

/** Faux client de l'API des mémoires : note chaque appel, tient les mémoires en mémoire vive. */
function fakeApi() {
  const calls: Call[] = []
  const state = {
    storeName: 'Notes',
    memories: new Map<string, Stored>(),
    updateError: null as Error | null,
    /** Les réponses de create et d'update rendent `content: null`, comme en vue `basic`. */
    stripContent: false,
    /** Les retrieve rendent `content: null` malgré `view: 'full'`. */
    nullOnRetrieve: false,
    /** Le serveur change le texte reçu avant de le garder (retours à la ligne, espaces). */
    transform: (text: string): string => text,
    nextId: 'mem_new'
  }
  const toMemory = (id: string, stored: Stored, withContent: boolean) => ({
    type: 'memory',
    id,
    memory_store_id: 'memstore_1',
    path: stored.path,
    content: withContent ? stored.content : null,
    content_sha256: stored.sha ?? sha(stored.content),
    content_size_bytes: Buffer.byteLength(stored.content),
    created_at: '2026-11-22T10:00:00Z',
    updated_at: '2026-11-22T10:00:01Z',
    memory_version_id: 'memver_1'
  })
  const client = {
    beta: {
      memoryStores: {
        retrieve: async (id: string) => {
          calls.push({ method: 'memoryStores.retrieve', args: [id] })
          return { id, name: state.storeName, description: '', updated_at: 't' }
        },
        memories: {
          retrieve: async (id: string, params: unknown) => {
            calls.push({ method: 'memories.retrieve', args: [id, params] })
            const stored = state.memories.get(id)
            if (!stored) throw new Error(`no memory ${id}`)
            return toMemory(id, stored, !state.nullOnRetrieve)
          },
          create: async (storeId: string, params: { path: string; content: string }) => {
            calls.push({ method: 'memories.create', args: [storeId, params] })
            const stored = { path: params.path, content: state.transform(params.content) }
            state.memories.set(state.nextId, stored)
            return toMemory(state.nextId, stored, !state.stripContent)
          },
          update: async (id: string, params: { content?: string; path?: string }) => {
            calls.push({ method: 'memories.update', args: [id, params] })
            if (state.updateError) throw state.updateError
            const stored = state.memories.get(id)
            if (!stored) throw new Error(`no memory ${id}`)
            const next: Stored = {
              path: params.path ?? stored.path,
              content: params.content === undefined ? stored.content : state.transform(params.content)
            }
            state.memories.set(id, next)
            return toMemory(id, next, !state.stripContent)
          }
        }
      }
    }
  }
  const store = { get: async () => client, reset() {}, hasKey: async () => true } as unknown as ClientStore
  return { store, state, calls }
}

function setup() {
  const folder = tempFolder()
  const fake = fakeHost(folder)
  const api = fakeApi()
  api.state.memories.set('mem_1', { path: '/notes/a.md', content: 'hello\n' })
  const pending = createPendingWrites(() => 0)
  const logs: string[] = []
  const holder: { drafts?: Drafts } = {}
  const adapter = createMemoryAdapter(api.store, () => holder.drafts as Drafts, (message) => logs.push(message))
  const drafts = createDrafts({
    folder,
    host: fake.host,
    adapters: { memory: adapter },
    pending,
    now: () => new Date('2026-11-22T10:00:00.000Z'),
    log: (message) => logs.push(message)
  })
  holder.drafts = drafts
  const rename = createMemoryRename(api.store, () => drafts)
  /** Le geste du panneau : `draft.prepare` puis `write.commit`. */
  const apply = async (ref: DraftRef, force = false) => {
    const prepared = await drafts.prepare(ref)
    return prepared.ok ? pending.commit(prepared.value.token, force) : prepared
  }
  const registry = () => JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8')) as { entries: Record<string, { ref: DraftRef; base: unknown }> }
  return { folder, fake, api, pending, logs, drafts, rename, apply, registry }
}

const only = (calls: Call[], method: string): Call[] => calls.filter((call) => call.method === method)

test('draft.open with a refused path answers invalid and creates no file', async () => {
  const { drafts, folder, api } = setup()
  for (const path of ['notes.md', '/../../.ssh/id', '/a//b']) {
    const result = await drafts.open({ ...NEW, path })
    expect(result).toEqual({ ok: false, code: 'invalid', error: 'A memory path starts with / and has no . or .. segments.' })
  }
  expect(readdirSync(folder)).toEqual([])
  expect(api.calls).toEqual([])
  cleanup()
})

test('open writes the live content of an existing memory under the store folder and records its hash as the base', async () => {
  const { drafts, folder, registry, fake } = setup()
  const result = await drafts.open(EXISTING)
  expect(result.ok && result.value.file).toBe(EXISTING_FILE)
  expect(readFileSync(join(folder, EXISTING_FILE), 'utf8')).toBe('hello\n')
  expect(registry().entries[EXISTING_FILE]?.base).toEqual({ sha256: sha('hello\n') })
  expect(fake.calls).toEqual(['show ws-drafts', `open ws-drafts ${EXISTING_FILE}`])
  cleanup()
})

test('open of a new memory writes an empty file and has nothing to apply until it is edited', async () => {
  const { drafts, folder, apply } = setup()
  const result = await drafts.open(NEW)
  expect(result.ok && result.value.file).toBe(NEW_FILE)
  expect(readFileSync(join(folder, NEW_FILE), 'utf8')).toBe('')
  expect(await apply(NEW)).toEqual({ ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: save the file first (⌘S).' })
  cleanup()
})

test('open fails readably, and writes no file, when the API gives no content for a memory it was asked in full', async () => {
  const { drafts, folder, api } = setup()
  api.state.nullOnRetrieve = true
  const result = await drafts.open(EXISTING)
  expect(result).toEqual({ ok: false, code: 'other', error: 'The API returned no content for this memory.' })
  expect(existsSync(join(folder, EXISTING_FILE))).toBe(false)
  cleanup()
})

test('an update carries the content_sha256 precondition of the recorded base, and none when forced', async () => {
  const { drafts, folder, apply, api } = setup()
  api.state.memories.set('mem_1', { path: '/notes/a.md', content: 'hello\n', sha: 'abc' })
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'edited\n')
  expect(await apply(EXISTING)).toEqual({ ok: true, value: { label: 'Applied' } })
  expect(only(api.calls, 'memories.update')[0]?.args).toEqual([
    'mem_1',
    { memory_store_id: 'memstore_1', content: 'edited\n', precondition: { type: 'content_sha256', content_sha256: 'abc' }, view: 'full' }
  ])

  const forced = setup()
  forced.api.state.memories.set('mem_1', { path: '/notes/a.md', content: 'hello\n', sha: 'abc' })
  await forced.drafts.open(EXISTING)
  writeFileSync(join(forced.folder, EXISTING_FILE), 'edited\n')
  expect((await forced.apply(EXISTING, true)).ok).toBe(true)
  const params = only(forced.api.calls, 'memories.update')[0]?.args[1] as Record<string, unknown>
  expect('precondition' in params).toBe(false)
  expect(params).toEqual({ memory_store_id: 'memstore_1', content: 'edited\n', view: 'full' })
  cleanup()
})

test('a precondition refusal is a conflict, keeps the file and the token, and a forced retry goes through', async () => {
  const { drafts, folder, pending, api } = setup()
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'edited\n')
  // Corps réel capturé le 22/11 (docs/superpowers/runs/lot2/t7-precondition-probe.log).
  const body = {
    type: 'error',
    error: { type: 'memory_precondition_failed_error', message: 'precondition content_sha256 failed: content has changed' },
    request_id: 'req_test'
  }
  api.state.updateError = new Anthropic.ConflictError(409, body, undefined, new Headers())
  const prepared = await drafts.prepare(EXISTING)
  if (!prepared.ok) throw new Error('prepare failed')
  expect(await pending.commit(prepared.value.token, false)).toEqual({ ok: false, code: 'conflict', error: CONFLICT_MESSAGE })
  expect(readFileSync(join(folder, EXISTING_FILE), 'utf8')).toBe('edited\n')
  const state = await drafts.state(EXISTING)
  expect(state.ok && state.value?.unapplied).toBe(true)

  api.state.updateError = null
  expect(await pending.commit(prepared.value.token, true)).toEqual({ ok: true, value: { label: 'Applied' } })
  cleanup()
})

test('a path conflict on create stays an ordinary API error, not a conflict', async () => {
  const { drafts, folder, apply, api } = setup()
  await drafts.open(NEW)
  writeFileSync(join(folder, NEW_FILE), 'text\n')
  const body = { type: 'error', error: { type: 'memory_path_conflict_error', message: 'a memory already exists at /notes/new.md' } }
  api.state.memories.set('mem_x', { path: '/notes/new.md', content: '' })
  const client = (await api.store.get()) as unknown as { beta: { memoryStores: { memories: { create: unknown } } } }
  client.beta.memoryStores.memories.create = async () => {
    throw new Anthropic.ConflictError(409, body, undefined, new Headers())
  }
  expect(await apply(NEW)).toEqual({ ok: false, code: 'other', error: 'API error 409: a memory already exists at /notes/new.md' })
  cleanup()
})

test('after an update whose response has no content, the file keeps the text that was sent, never an empty file', async () => {
  const { drafts, folder, apply, api } = setup()
  api.state.stripContent = true
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'edited\n')
  const reads = only(api.calls, 'memories.retrieve').length
  expect((await apply(EXISTING)).ok).toBe(true)
  expect(readFileSync(join(folder, EXISTING_FILE), 'utf8')).toBe('edited\n')
  // Le texte envoyé a l'empreinte rendue : aucune relecture n'est nécessaire (une seule, celle de l'aperçu).
  expect(only(api.calls, 'memories.retrieve').length).toBe(reads + 1)
  const state = await drafts.state(EXISTING)
  expect(state.ok && state.value?.unapplied).toBe(false)
  cleanup()
})

test('after an update whose response has no content and another hash, the memory is read again in full', async () => {
  const { drafts, folder, apply, api } = setup()
  api.state.stripContent = true
  api.state.transform = (text) => `${text.trimEnd()}\n`
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'edited   \n\n')
  expect((await apply(EXISTING)).ok).toBe(true)
  expect(readFileSync(join(folder, EXISTING_FILE), 'utf8')).toBe('edited\n')
  const last = only(api.calls, 'memories.retrieve').at(-1)
  expect(last?.args).toEqual(['mem_1', { memory_store_id: 'memstore_1', view: 'full' }])
  const state = await drafts.state(EXISTING)
  expect(state.ok && state.value?.unapplied).toBe(false)
  cleanup()
})

test('a send stays a success when the file cannot be rewritten afterwards, and logs it', async () => {
  const { drafts, folder, apply, api, logs } = setup()
  api.state.stripContent = true
  api.state.transform = (text) => `${text.trimEnd()}\n`
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'edited   \n\n')
  // La relecture échoue : l'envoi est fait, le brouillon reste tel quel, et la tâche ne devient pas un échec.
  const client = (await api.store.get()) as unknown as { beta: { memoryStores: { memories: { retrieve: unknown } } } }
  let reads = 0
  const original = client.beta.memoryStores.memories.retrieve as (id: string, params: unknown) => Promise<unknown>
  client.beta.memoryStores.memories.retrieve = async (id: string, params: unknown) => {
    reads += 1
    // La première lecture est celle de l'aperçu ; la seconde, celle d'après l'envoi, échoue.
    if (reads === 2) throw new Error('network down')
    return original(id, params)
  }
  expect(await apply(EXISTING)).toEqual({ ok: true, value: { label: 'Applied' } })
  expect(readFileSync(join(folder, EXISTING_FILE), 'utf8')).toBe('edited   \n\n')
  expect(logs.some((line) => line.includes('network down'))).toBe(true)
  cleanup()
})

test('create and update both ask for the full view, and create sends no precondition', async () => {
  const { drafts, folder, apply, api } = setup()
  await drafts.open(NEW)
  writeFileSync(join(folder, NEW_FILE), 'first\n')
  expect((await apply(NEW)).ok).toBe(true)
  expect(only(api.calls, 'memories.create')[0]?.args).toEqual(['memstore_1', { path: '/notes/new.md', content: 'first\n', view: 'full' }])

  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'second\n')
  expect((await apply(EXISTING)).ok).toBe(true)
  const update = only(api.calls, 'memories.update')[0]?.args[1] as { view?: string }
  expect(update.view).toBe('full')
  cleanup()
})

test('after a create the registry entry holds the new memory id and a second Apply updates instead of creating again', async () => {
  const { drafts, folder, apply, api, registry } = setup()
  await drafts.open(NEW)
  writeFileSync(join(folder, NEW_FILE), 'first\n')
  expect((await apply(NEW)).ok).toBe(true)
  expect(registry().entries[NEW_FILE]?.ref).toEqual({ ...NEW, memoryId: 'mem_new' })
  expect(registry().entries[NEW_FILE]?.base).toEqual({ sha256: sha('first\n') })
  expect(readFileSync(join(folder, NEW_FILE), 'utf8')).toBe('first\n')

  // Le panneau garde la référence de la création : le second Apply la retrouve quand même.
  writeFileSync(join(folder, NEW_FILE), 'second\n')
  expect((await apply(NEW)).ok).toBe(true)
  expect(only(api.calls, 'memories.create').length).toBe(1)
  expect(only(api.calls, 'memories.update')[0]?.args).toEqual([
    'mem_new',
    { memory_store_id: 'memstore_1', content: 'second\n', precondition: { type: 'content_sha256', content_sha256: sha('first\n') }, view: 'full' }
  ])
  cleanup()
})

test('a second Apply with the reference carrying the new id finds the same draft', async () => {
  const { drafts, folder, apply, api } = setup()
  await drafts.open(NEW)
  writeFileSync(join(folder, NEW_FILE), 'first\n')
  await apply(NEW)
  writeFileSync(join(folder, NEW_FILE), 'second\n')
  expect((await apply({ ...NEW, memoryId: 'mem_new' })).ok).toBe(true)
  expect(only(api.calls, 'memories.create').length).toBe(1)
  expect(only(api.calls, 'memories.update').length).toBe(1)
  cleanup()
})

test('reopening a created draft with the creation reference reads the memory back: the file is never emptied', async () => {
  const { drafts, folder, apply, api, registry } = setup()
  await drafts.open(NEW)
  writeFileSync(join(folder, NEW_FILE), 'first\n')
  await apply(NEW)
  const again = await drafts.open(NEW)
  expect(again.ok && again.value.unapplied).toBe(false)
  expect(readFileSync(join(folder, NEW_FILE), 'utf8')).toBe('first\n')
  const state = await drafts.state(NEW)
  expect(state.ok && state.value?.unapplied).toBe(false)
  // Rouvrir ne fait pas oublier la mémoire créée : l'Apply suivant la met à jour.
  expect(registry().entries[NEW_FILE]?.ref).toEqual({ ...NEW, memoryId: 'mem_new' })
  writeFileSync(join(folder, NEW_FILE), 'third\n')
  expect((await apply(NEW)).ok).toBe(true)
  expect(only(api.calls, 'memories.create').length).toBe(1)
  expect(only(api.calls, 'memories.update').length).toBe(1)
  cleanup()
})

test('the preview of a creation lists the added lines, the one of an update compares with the live memory', async () => {
  const { drafts, folder, api } = setup()
  await drafts.open(NEW)
  writeFileSync(join(folder, NEW_FILE), 'one\ntwo\n')
  const created = await drafts.prepare(NEW)
  expect(created.ok && created.value.creates).toBe(true)
  expect(created.ok && created.value.changes).toEqual([{ path: 'content', before: '', after: 'one\ntwo\n', lines: { added: 3, removed: 0 } }])

  api.state.memories.set('mem_1', { path: '/notes/a.md', content: 'a\nb\n' })
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'a\nc\n')
  const updated = await drafts.prepare(EXISTING)
  expect(updated.ok && updated.value.creates).toBe(false)
  expect(updated.ok && updated.value.changes).toEqual([{ path: 'content', before: 'a\nb\n', after: 'a\nc\n', lines: { added: 1, removed: 1 } }])
  cleanup()
})

test('a draft is found again after its store was renamed: same store id, new slug', async () => {
  const { drafts, folder, api } = setup()
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'my edit\n')
  api.state.storeName = 'Journal'
  api.calls.length = 0

  const state = await drafts.state(EXISTING)
  expect(state.ok && state.value?.file).toBe(EXISTING_FILE)
  expect(state.ok && state.value?.unapplied).toBe(true)
  const reopened = await drafts.open(EXISTING)
  expect(reopened.ok && reopened.value.file).toBe(EXISTING_FILE)
  expect(readFileSync(join(folder, EXISTING_FILE), 'utf8')).toBe('my edit\n')
  // Aucune relecture de la banque : le dossier se retrouve par son suffixe, pas par son nom.
  expect(only(api.calls, 'memoryStores.retrieve')).toEqual([])
  expect(readdirSync(join(folder, 'memories'))).toEqual(['notes--memstore_1'])

  // Une autre mémoire de la même banque rejoint le dossier existant ; une autre banque prend le nouveau nom.
  const sibling = await drafts.open(NEW)
  expect(sibling.ok && sibling.value.file).toBe(NEW_FILE)
  const other = await drafts.open({ ...NEW, memoryStoreId: 'memstore_2' })
  expect(other.ok && other.value.file).toBe('memories/journal--memstore_2/notes/new.md')
  cleanup()
})

test('a draft is found by its memory id, not by its path: a renamed memory keeps its draft', async () => {
  const { drafts, folder } = setup()
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'my edit\n')
  const renamed: MemoryRef = { ...EXISTING, path: '/notes/renamed.md' }
  const state = await drafts.state(renamed)
  expect(state.ok && state.value?.file).toBe(EXISTING_FILE)
  expect(state.ok && state.value?.unapplied).toBe(true)
  const reopened = await drafts.open(renamed)
  expect(reopened.ok && reopened.value.unapplied).toBe(true)
  expect(readFileSync(join(folder, EXISTING_FILE), 'utf8')).toBe('my edit\n')
  cleanup()
})

test('a memory path holding the recovery infix is reserved and never opens a file', async () => {
  const { drafts, folder } = setup()
  const result = await drafts.open({ ...NEW, path: '/notes/x.recovered-2026-11-22.md' })
  expect(result).toEqual({ ok: false, code: 'other', error: 'This draft file name is reserved.' })
  expect(readdirSync(folder)).toEqual([])
  cleanup()
})

const RENAME = { memoryStoreId: 'memstore_1', memoryId: 'mem_1', path: '/notes/b.md', baseSha256: 'abc' }

test('memory.rename sends the new path and the content_sha256 precondition, and answers the id and stamp', async () => {
  const { rename, api } = setup()
  expect(await rename(RENAME)).toEqual({ ok: true, value: { id: 'mem_1', updatedAt: '2026-11-22T10:00:01Z' } })
  expect(api.calls).toEqual([
    {
      method: 'memories.update',
      args: ['mem_1', { memory_store_id: 'memstore_1', path: '/notes/b.md', precondition: { type: 'content_sha256', content_sha256: 'abc' } }]
    }
  ])
  cleanup()
})

test('memory.rename refuses an unsafe path before any network call', async () => {
  const { rename, api } = setup()
  expect(await rename({ ...RENAME, path: 'notes.md' })).toEqual({
    ok: false,
    code: 'invalid',
    error: 'A memory path starts with / and has no . or .. segments.'
  })
  expect(api.calls).toEqual([])
  cleanup()
})

test('memory.rename on a precondition refusal is a conflict', async () => {
  const { rename, api } = setup()
  const body = { type: 'error', error: { type: 'memory_precondition_failed_error', message: 'changed' } }
  api.state.updateError = new Anthropic.ConflictError(409, body, undefined, new Headers())
  expect(await rename(RENAME)).toEqual({ ok: false, code: 'conflict', error: CONFLICT_MESSAGE })
  cleanup()
})

test('memory.rename refuses while the draft of that memory is unapplied, without any network call, and goes through after a discard', async () => {
  const { drafts, folder, rename, api } = setup()
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'my edit\n')
  api.calls.length = 0
  expect(await rename(RENAME)).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Apply or discard the open draft of this memory first.'
  })
  expect(api.calls).toEqual([])

  await drafts.discard(EXISTING)
  api.calls.length = 0
  expect((await rename(RENAME)).ok).toBe(true)
  expect(api.calls.map((call) => call.method)).toEqual(['memories.update'])
  cleanup()
})

test('memory.rename is not blocked by the unapplied draft of another memory', async () => {
  const { drafts, folder, rename } = setup()
  await drafts.open(NEW)
  writeFileSync(join(folder, NEW_FILE), 'unsent\n')
  expect((await rename(RENAME)).ok).toBe(true)
  cleanup()
})
