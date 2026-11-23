import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UploadItem } from '../protocol'
import { INVALID_MEMORY_PATH } from '../shared/memory-path'
import { CONFLICT_MESSAGE, type ClientStore } from './client'
import { createFilePicker, createMemoryUploads } from './memory-uploads'
import { createPendingWrites } from './pending-writes'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/** Chaîne témoin : elle ne doit apparaître ni dans un journal ni dans un message d'erreur. */
const SECRET = 'plugin-test-content-QUOKKA-xyz'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cma-memory-uploads-'))
  dirs.push(dir)
  return dir
}
function cleanup(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Call = { method: string; args: unknown[] }
type Stored = { path: string; content: string }

const notFound = (id: string): Error =>
  new Anthropic.NotFoundError(404, { type: 'error', error: { type: 'not_found_error', message: `no memory ${id}` } }, undefined, new Headers())

/** Faux client de l'API des mémoires : note chaque appel, tient les mémoires en mémoire vive. */
function fakeApi() {
  const calls: Call[] = []
  const state = {
    memories: new Map<string, Stored>(),
    /** Erreurs à lever, dans l'ordre, aux prochains envois (create ou update). */
    sendErrors: [] as (Error | null)[],
    nextId: 1
  }
  const toMemory = (id: string, stored: Stored) => ({
    type: 'memory',
    id,
    memory_store_id: 'memstore_1',
    path: stored.path,
    content: stored.content,
    content_sha256: sha(stored.content),
    content_size_bytes: Buffer.byteLength(stored.content),
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:00:01Z',
    memory_version_id: 'memver_1'
  })
  const failNext = (): void => {
    const error = state.sendErrors.shift()
    if (error) throw error
  }
  const client = {
    beta: {
      memoryStores: {
        memories: {
          async *list(storeId: string) {
            calls.push({ method: 'memories.list', args: [storeId] })
            for (const [id, stored] of state.memories) yield { ...toMemory(id, stored), content: null }
          },
          retrieve: async (id: string, params: unknown) => {
            calls.push({ method: 'memories.retrieve', args: [id, params] })
            const stored = state.memories.get(id)
            if (!stored) throw notFound(id)
            return toMemory(id, stored)
          },
          create: async (storeId: string, params: { path: string; content: string }) => {
            calls.push({ method: 'memories.create', args: [storeId, params] })
            failNext()
            const id = `mem_new${state.nextId++}`
            state.memories.set(id, { path: params.path, content: params.content })
            return toMemory(id, { path: params.path, content: params.content })
          },
          update: async (id: string, params: { content?: string }) => {
            calls.push({ method: 'memories.update', args: [id, params] })
            failNext()
            const stored = state.memories.get(id)
            if (!stored) throw notFound(id)
            const next = { path: stored.path, content: params.content ?? stored.content }
            state.memories.set(id, next)
            return toMemory(id, next)
          }
        }
      }
    }
  }
  const store = { get: async () => client, reset() {}, hasKey: async () => true } as unknown as ClientStore
  return { store, state, calls }
}

function setup() {
  const dir = tempDir()
  const api = fakeApi()
  api.state.memories.set('mem_1', { path: '/notes/a.md', content: 'hello\n' })
  const pending = createPendingWrites(() => 0)
  const logs: string[] = []
  const stageUploads = createMemoryUploads(api.store, pending, (message) => logs.push(message))
  const file = (name: string, data: string | Uint8Array): string => {
    const path = join(dir, name)
    writeFileSync(path, data)
    return path
  }
  const only = (method: string): Call[] => api.calls.filter((call) => call.method === method)
  return { dir, api, pending, logs, stageUploads, file, only }
}

const item = (path: string, file: string, memoryId: string | null = null): UploadItem => ({ path, file, memoryId })

test('two creations stage a single write with two changes and send each file byte for byte', async () => {
  const { stageUploads, file, pending, only, api } = setup()
  const first = file('first.md', `# first\nline two ${SECRET}\n`)
  const second = file('second.md', 'été ✓\n')
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/first.md', first), item('/notes/second.md', second)] })
  if (!staged.ok) throw new Error(staged.error)
  expect(staged.value.creates).toBe(true)
  expect(staged.value.totalChanges).toBe(2)
  expect(staged.value.changes.map((change) => change.path)).toEqual(['/notes/first.md', '/notes/second.md'])
  expect(staged.value.changes[0]).toEqual({ path: '/notes/first.md', before: null, after: `# first\nline two ${SECRET}\n`, lines: { added: 3, removed: 0 } })
  // Rien n'est écrit avant la confirmation.
  expect(only('memories.create')).toEqual([])

  expect(await pending.commit(staged.value.token, false)).toEqual({ ok: true, value: { label: 'Uploaded 2 memories' } })
  const creates = only('memories.create')
  expect(creates.map((call) => call.args)).toEqual([
    ['memstore_1', { path: '/notes/first.md', content: `# first\nline two ${SECRET}\n`, view: 'full' }],
    ['memstore_1', { path: '/notes/second.md', content: 'été ✓\n', view: 'full' }]
  ])
  expect(api.state.memories.size).toBe(3)
  cleanup()
})

test('a single file says Uploaded 1 memory, and a leading byte order mark is kept', async () => {
  const { stageUploads, file, pending, only } = setup()
  const path = file('bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]))
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/bom.md', path)] })
  if (!staged.ok) throw new Error(staged.error)
  expect(await pending.commit(staged.value.token, false)).toEqual({ ok: true, value: { label: 'Uploaded 1 memory' } })
  const content = (only('memories.create')[0]?.args[1] as { content: string }).content
  expect(sha(content)).toBe(sha(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')])))
  cleanup()
})

test('a replacement is staged with the live hash as precondition and no precondition when forced', async () => {
  const { stageUploads, file, pending, only } = setup()
  const path = file('a.md', 'hello\nworld\n')
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', path, 'mem_1')] })
  if (!staged.ok) throw new Error(staged.error)
  expect(staged.value.creates).toBe(false)
  expect(staged.value.changes).toEqual([{ path: '/notes/a.md', before: 'hello\n', after: 'hello\nworld\n', lines: { added: 1, removed: 0 } }])
  expect(only('memories.retrieve')[0]?.args).toEqual(['mem_1', { memory_store_id: 'memstore_1', view: 'full' }])
  expect(await pending.commit(staged.value.token, false)).toEqual({ ok: true, value: { label: 'Uploaded 1 memory' } })
  expect(only('memories.update')[0]?.args).toEqual([
    'mem_1',
    { memory_store_id: 'memstore_1', content: 'hello\nworld\n', precondition: { type: 'content_sha256', content_sha256: sha('hello\n') }, view: 'full' }
  ])

  const forced = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', file('b.md', 'again\n'), 'mem_1')] })
  if (!forced.ok) throw new Error(forced.error)
  expect((await pending.commit(forced.value.token, true)).ok).toBe(true)
  const params = only('memories.update')[1]?.args[1] as Record<string, unknown>
  expect('precondition' in params).toBe(false)
  expect(params).toEqual({ memory_store_id: 'memstore_1', content: 'again\n', view: 'full' })
  cleanup()
})

test('a captured precondition refusal is a conflict, keeps the token, and a forced retry goes through', async () => {
  const { stageUploads, file, pending, api } = setup()
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', file('a.md', 'new\n'), 'mem_1')] })
  if (!staged.ok) throw new Error(staged.error)
  // Corps réel capturé le 22/11 (docs/superpowers/runs/lot2/t7-precondition-probe.log).
  const body = {
    type: 'error',
    error: { type: 'memory_precondition_failed_error', message: 'precondition content_sha256 failed: content has changed' },
    request_id: 'req_test'
  }
  api.state.sendErrors.push(new Anthropic.ConflictError(409, body, undefined, new Headers()))
  expect(await pending.commit(staged.value.token, false)).toEqual({ ok: false, code: 'conflict', error: CONFLICT_MESSAGE })
  expect(api.state.memories.get('mem_1')?.content).toBe('hello\n')
  expect(await pending.commit(staged.value.token, true)).toEqual({ ok: true, value: { label: 'Uploaded 1 memory' } })
  expect(api.state.memories.get('mem_1')?.content).toBe('new\n')
  cleanup()
})

test('a retry after a failure sends only the lines not yet sent, and the progress prefixes the error', async () => {
  const { stageUploads, file, pending, only, api } = setup()
  const items = [item('/one.md', file('one.md', '1\n')), item('/two.md', file('two.md', '2\n')), item('/three.md', file('three.md', '3\n'))]
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items })
  if (!staged.ok) throw new Error(staged.error)
  // La première ligne passe, la deuxième échoue : une erreur 500 de l'API.
  api.state.sendErrors.push(null, new Anthropic.InternalServerError(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }, undefined, new Headers()))
  const failed = await pending.commit(staged.value.token, false)
  expect(failed).toEqual({ ok: false, code: 'other', error: 'Uploaded 1 of 3. API error 500: boom' })
  expect(only('memories.create').map((call) => (call.args[1] as { path: string }).path)).toEqual(['/one.md', '/two.md'])

  // Le réessai (ou « Apply anyway ») ne recrée pas la première ligne.
  expect(await pending.commit(staged.value.token, true)).toEqual({ ok: true, value: { label: 'Uploaded 3 memories' } })
  expect(only('memories.create').map((call) => (call.args[1] as { path: string }).path)).toEqual(['/one.md', '/two.md', '/two.md', '/three.md'])
  expect(Array.from(api.state.memories.values()).filter((memory) => memory.path === '/one.md').length).toBe(1)
  cleanup()
})

test('a failure on the first line carries no progress prefix', async () => {
  const { stageUploads, file, pending, api } = setup()
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/one.md', file('one.md', '1\n'))] })
  if (!staged.ok) throw new Error(staged.error)
  api.state.sendErrors.push(new Anthropic.RateLimitError(429, undefined, undefined, new Headers()))
  expect(await pending.commit(staged.value.token, false)).toEqual({ ok: false, code: 'other', error: 'Rate limited (429). Try again shortly.' })
  cleanup()
})

test('every refusal answers invalid on the first faulty line and sends nothing', async () => {
  const { stageUploads, file, dir, api } = setup()
  const good = file('good.md', 'ok\n')
  const missing = join(dir, 'gone.md')
  const withNul = file('nul.bin', Buffer.from([0x61, 0x00, 0x62]))
  const notUtf8 = file('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  const textOnly = 'This file is not text: memories hold UTF-8 text.'
  const refusals: { name: string; items: UploadItem[]; error: string }[] = [
    { name: 'nothing', items: [], error: 'Nothing to upload.' },
    { name: 'bad path', items: [item('notes.md', good)], error: INVALID_MEMORY_PATH },
    { name: 'bad path after a good one', items: [item('/a.md', good), item('/a//b', good)], error: INVALID_MEMORY_PATH },
    { name: 'duplicate by case', items: [item('/Notes.md', good), item('/notes.md', good)], error: '/notes.md: A memory already has this path.' },
    { name: 'missing file', items: [item('/m.md', missing)], error: 'Could not read gone.md.' },
    { name: 'directory', items: [item('/d.md', dir)], error: `Could not read ${dir.split('/').pop()}.` },
    { name: 'NUL byte', items: [item('/n.md', withNul)], error: `/n.md: ${textOnly}` },
    { name: 'not UTF-8', items: [item('/l.md', notUtf8)], error: `/l.md: ${textOnly}` }
  ]
  for (const refusal of refusals) {
    const result = await stageUploads({ memoryStoreId: 'memstore_1', items: refusal.items })
    expect({ name: refusal.name, result }).toEqual({ name: refusal.name, result: { ok: false, code: 'invalid', error: refusal.error } })
  }
  // Aucune requête : ni lecture ni écriture.
  expect(api.calls).toEqual([])
  cleanup()
})

test('a path taken in the store by another memory is refused, case insensitively; its own memory may be replaced', async () => {
  const { stageUploads, file, only } = setup()
  const path = file('a.md', 'x\n')
  expect(await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', path)] })).toEqual({
    ok: false,
    code: 'invalid',
    error: '/notes/a.md: A memory already has this path.'
  })
  expect(await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/Notes/A.md', path)] })).toEqual({
    ok: false,
    code: 'invalid',
    error: '/Notes/A.md: A memory already has this path.'
  })
  // Un remplacement d'une AUTRE mémoire sur ce chemin est refusé aussi.
  expect((await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', path, 'mem_other')] })).ok).toBe(false)
  expect((await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', path, 'mem_1')] })).ok).toBe(true)
  expect(only('memories.create')).toEqual([])
  cleanup()
})

test('a replacement identical to the live content is skipped, and all identical means nothing to apply', async () => {
  const { stageUploads, file, pending, only } = setup()
  const same = file('same.md', 'hello\n')
  const other = file('other.md', 'brand new\n')
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', same, 'mem_1'), item('/other.md', other)] })
  if (!staged.ok) throw new Error(staged.error)
  expect(staged.value.totalChanges).toBe(1)
  expect(staged.value.changes.map((change) => change.path)).toEqual(['/other.md'])
  expect(await pending.commit(staged.value.token, false)).toEqual({ ok: true, value: { label: 'Uploaded 1 memory' } })
  expect(only('memories.update')).toEqual([])

  expect(await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', same, 'mem_1')] })).toEqual({
    ok: false,
    code: 'nothing_to_apply',
    error: 'Nothing to apply: these files match the memories.'
  })
  cleanup()
})

test('a replaced memory the API no longer knows is a readable failure, not an exception', async () => {
  const { stageUploads, file } = setup()
  const result = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/gone.md', file('g.md', 'x\n'), 'mem_missing')] })
  expect(result).toEqual({ ok: false, code: 'other', error: 'Not found (404).' })
  cleanup()
})

test('file contents appear in no log line and no error message, only base names', async () => {
  const { stageUploads, file, pending, logs, dir, api } = setup()
  const path = file('leaky.md', `${SECRET}\n`)
  const staged = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/leaky.md', path), item('/two.md', file('two.md', `${SECRET} two\n`))] })
  if (!staged.ok) throw new Error(staged.error)
  api.state.sendErrors.push(null, new Error('network down'))
  const failed = await pending.commit(staged.value.token, false)
  const refused = await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/x.md', join(dir, 'absent.md'))] })
  const texts = [...logs, JSON.stringify(failed), JSON.stringify(refused)]
  for (const text of texts) {
    expect(text.includes(SECRET)).toBe(false)
    expect(text.includes(dir)).toBe(false)
  }
  expect(JSON.stringify(refused)).toBe('{"ok":false,"code":"invalid","error":"Could not read absent.md."}')
  cleanup()
})

test('file.pick answers the chosen path and its base name, trimming the trailing newline', async () => {
  const calls: string[][] = []
  const pick = createFilePicker({
    platform: 'darwin',
    run: async (args) => {
      calls.push(args)
      return '/Users/test/Documents/notes today.md\n'
    }
  })
  expect(await pick()).toEqual({ ok: true, value: { file: '/Users/test/Documents/notes today.md', name: 'notes today.md' } })
  expect(calls.length).toBe(1)
  expect(calls[0]?.[0]).toBe('-e')
  expect(calls[0]?.[1]).toBe('POSIX path of (choose file with prompt "Choose a file to upload as a memory")')
})

test('file.pick answers null when the user cancels (osascript error -128)', async () => {
  const pick = createFilePicker({
    platform: 'darwin',
    run: async () => {
      throw new Error('Command failed: osascript\n0:49: execution error: User canceled. (-128)')
    }
  })
  expect(await pick()).toEqual({ ok: true, value: null })
})

test('file.pick fails readably on another error, and off macOS never runs anything', async () => {
  const broken = createFilePicker({
    platform: 'darwin',
    run: async () => {
      throw new Error('osascript: command not found')
    }
  })
  expect(await broken()).toEqual({ ok: false, code: 'other', error: 'Could not open the file picker.' })

  let ran = 0
  const linux = createFilePicker({
    platform: 'linux',
    run: async () => {
      ran++
      return '/x'
    }
  })
  expect(await linux()).toEqual({ ok: false, code: 'other', error: 'File picking works on macOS only.' })
  expect(ran).toBe(0)
})

test('overlapping paths are refused before any request, between rows and against the store, in both directions', async () => {
  const { stageUploads, file, api, only } = setup()
  const path = file('x.md', 'x\n')
  const taken = 'A memory already has this path.'
  // `faulty` : la ligne que le refus nomme (la première en défaut, dans l'ordre).
  const cases: { name: string; items: UploadItem[]; faulty: string }[] = [
    { name: 'row ancestor then descendant', items: [item('/docs', path), item('/docs/todo.md', path)], faulty: '/docs/todo.md' },
    { name: 'row descendant then ancestor', items: [item('/docs/todo.md', path), item('/docs', path)], faulty: '/docs' },
    { name: 'row case-insensitive overlap', items: [item('/Docs', path), item('/docs/todo.md', path)], faulty: '/docs/todo.md' },
    { name: 'row ancestor of a store memory', items: [item('/notes', path)], faulty: '/notes' },
    { name: 'row descendant of a store memory', items: [item('/notes/a.md/deeper.md', path)], faulty: '/notes/a.md/deeper.md' },
    { name: 'store overlap, case-insensitive', items: [item('/NOTES', path)], faulty: '/NOTES' }
  ]
  for (const entry of cases) {
    const result = await stageUploads({ memoryStoreId: 'memstore_1', items: entry.items })
    expect({ name: entry.name, result }).toEqual({ name: entry.name, result: { ok: false, code: 'invalid', error: `${entry.faulty}: ${taken}` } })
  }
  // Aucune écriture ; seule la relecture de la banque a eu lieu (les cas en ligne n'envoient rien).
  expect(only('memories.create')).toEqual([])
  expect(api.calls.every((call) => call.method === 'memories.list')).toBe(true)
  cleanup()
})

test('a sibling that only shares a name prefix does not overlap, and a replacement ignores its own memory', async () => {
  const { stageUploads, file } = setup()
  const path = file('x.md', 'x\n')
  expect((await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/doc', path), item('/docs.md', path), item('/notes/a.md.bak', path)] })).ok).toBe(true)
  expect((await stageUploads({ memoryStoreId: 'memstore_1', items: [item('/notes/a.md', path, 'mem_1')] })).ok).toBe(true)
  cleanup()
})

test('file.pick keeps trailing spaces of a file name and drops only the line ending', async () => {
  const pick = createFilePicker({ platform: 'darwin', run: async () => '/Users/test/notes .md \n' })
  expect(await pick()).toEqual({ ok: true, value: { file: '/Users/test/notes .md ', name: 'notes .md ' } })
  const crlf = createFilePicker({ platform: 'darwin', run: async () => '/Users/test/a.md\r\n' })
  expect(await crlf()).toEqual({ ok: true, value: { file: '/Users/test/a.md', name: 'a.md' } })
})

test('two concurrent file.pick calls share one dialog and one answer, and a later call opens a new one', async () => {
  let runs = 0
  let release: (output: string) => void = () => {}
  const pick = createFilePicker({
    platform: 'darwin',
    run: () => {
      runs++
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }
  })
  const first = pick()
  const second = pick()
  expect(runs).toBe(1)
  release('/Users/test/late.md\n')
  const expected = { ok: true, value: { file: '/Users/test/late.md', name: 'late.md' } }
  expect(await first).toEqual(expected)
  expect(await second).toEqual(expected)
  // La boîte est fermée : un nouvel appel en ouvre une autre.
  const third = pick()
  expect(runs).toBe(2)
  release('/Users/test/other.md')
  expect(await third).toEqual({ ok: true, value: { file: '/Users/test/other.md', name: 'other.md' } })
})

test('a failed or cancelled dialog is not kept: the next file.pick runs again', async () => {
  let runs = 0
  const pick = createFilePicker({
    platform: 'darwin',
    run: async () => {
      runs++
      throw new Error('User canceled. (-128)')
    }
  })
  expect(await pick()).toEqual({ ok: true, value: null })
  expect(await pick()).toEqual({ ok: true, value: null })
  expect(runs).toBe(2)
})
