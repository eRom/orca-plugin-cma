import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'
import { UPLOAD_UNCONFIRMED } from '../protocol'
import type { ClientStore } from './client'
import { FILE_TOO_LARGE, NO_SKILL_MD, type ReadUploads } from './resource-files'
import { createResourceHandlers, UPLOAD_TIMEOUT_MS } from './resources'

// Faux client : note chaque appel (méthode, arguments, options) ; les `list` rendent un itérable asynchrone
// comme la pagination du SDK, `create`/`upload` lèvent l'erreur donnée.
type Call = { method: string; args: unknown[] }

function fakeStore(
  options: { skills?: unknown[]; files?: unknown[]; uploadError?: unknown; created?: unknown; version?: unknown } = {}
) {
  const calls: Call[] = []
  const note = (method: string, args: unknown[]) => calls.push({ method, args })
  const iterable = (items: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
      yield* items
    }
  })
  const failIfAsked = () => {
    if (options.uploadError) {
      throw options.uploadError
    }
  }
  const client = {
    skills: {
      list: (...args: unknown[]) => (note('skills.list', args), iterable(options.skills ?? [])),
      create: async (...args: unknown[]) => {
        note('skills.create', args)
        failIfAsked()
        return options.created
      },
      delete: async (...args: unknown[]) => {
        note('skills.delete', args)
        return { id: 'skill_1', type: 'skill_deleted' }
      },
      versions: {
        create: async (...args: unknown[]) => {
          note('skills.versions.create', args)
          failIfAsked()
          return options.version
        }
      }
    },
    files: {
      list: (...args: unknown[]) => (note('files.list', args), iterable(options.files ?? [])),
      upload: async (...args: unknown[]) => {
        note('files.upload', args)
        failIfAsked()
        return options.created
      },
      delete: async (...args: unknown[]) => {
        note('files.delete', args)
        return { id: 'file_1', type: 'file_deleted' }
      }
    }
  }
  const store = { get: async () => client, reset() {}, hasKey: async () => true } as unknown as ClientStore
  return { store, calls }
}

const skillFiles = [new File(['x'], 'my-skill/SKILL.md')]
const readsOk = (files: File[] = skillFiles): (() => Promise<ReadUploads>) => async () => ({ ok: true, files, label: 'my-skill' })
const readsNothing = (): never => {
  throw new Error('the disk must not be read')
}

function handlersWith(
  store: ClientStore,
  read: { skillFolder?: () => Promise<ReadUploads>; uploadFile?: () => Promise<ReadUploads> } = {}
) {
  return createResourceHandlers(store, {
    skillFolder: read.skillFolder ?? readsNothing,
    uploadFile: read.uploadFile ?? readsNothing
  })
}

const skill = (id: string, updatedAt: string) => ({
  type: 'skill',
  id,
  display_name: `name-${id}`,
  source: { type: 'custom' },
  latest_version_id: `skver_${id}`,
  created_at: '2026-11-23T18:00:00.000000Z',
  updated_at: updatedAt
})

const fileMeta = (id: string, createdAt: string, extra: object = {}) => ({
  type: 'file',
  id,
  filename: `${id}.txt`,
  size_bytes: 19,
  created_at: createdAt,
  mime_type: 'text/plain',
  downloadable: false,
  expires_at: null,
  ...extra
})

test('lists Anthropic skills from the anthropic source, in the order the API gives', async () => {
  const { store, calls } = fakeStore({ skills: [skill('xlsx', '2026-11-16T17:00:22.704800Z'), skill('pdf', '2026-11-06T23:00:36.135606Z')] })
  const result = await handlersWith(store).listAnthropicSkills()
  expect(calls).toEqual([{ method: 'skills.list', args: [{ source: 'anthropic' }] }])
  expect(result.ok && result.value.map((row) => row.id)).toEqual(['xlsx', 'pdf'])
})

test('lists custom skills only, newest update first', async () => {
  const { store, calls } = fakeStore({
    skills: [
      skill('a', '2026-11-23T19:00:00.000000Z'),
      skill('b', '2026-11-23T19:42:00.000000Z'),
      skill('c', '2026-11-23T18:58:00.000000Z')
    ]
  })
  const result = await handlersWith(store).listSkills()
  expect(calls).toEqual([{ method: 'skills.list', args: [{ source: 'custom' }] }])
  expect(result).toEqual({
    ok: true,
    value: [
      { id: 'b', name: 'name-b', latestVersionId: 'skver_b', updatedAt: '2026-11-23T19:42:00.000000Z' },
      { id: 'a', name: 'name-a', latestVersionId: 'skver_a', updatedAt: '2026-11-23T19:00:00.000000Z' },
      { id: 'c', name: 'name-c', latestVersionId: 'skver_c', updatedAt: '2026-11-23T18:58:00.000000Z' }
    ]
  })
})

test('lists files newest first, with the session of a session-scoped file', async () => {
  const { store } = fakeStore({
    files: [
      fileMeta('old', '2026-11-23T18:00:00.000000Z'),
      fileMeta('new', '2026-11-23T20:00:00.000000Z', { scope: { type: 'session', id: 'sesn_1' } }),
      fileMeta('mid', '2026-11-23T19:00:00.000000Z')
    ]
  })
  const result = await handlersWith(store).listFiles()
  expect(result).toEqual({
    ok: true,
    value: [
      { id: 'new', name: 'new.txt', sizeBytes: 19, createdAt: '2026-11-23T20:00:00.000000Z', sessionId: 'sesn_1' },
      { id: 'mid', name: 'mid.txt', sizeBytes: 19, createdAt: '2026-11-23T19:00:00.000000Z', sessionId: null },
      { id: 'old', name: 'old.txt', sizeBytes: 19, createdAt: '2026-11-23T18:00:00.000000Z', sessionId: null }
    ]
  })
})

test('a scope that is not a session scope gives no session id', async () => {
  const { store } = fakeStore({
    files: [
      fileMeta('a', '2026-11-23T20:00:00.000000Z', { scope: { type: 'other', id: 'x' } }),
      fileMeta('b', '2026-11-23T19:00:00.000000Z', { scope: 'sesn_1' }),
      fileMeta('c', '2026-11-23T18:00:00.000000Z', { scope: { type: 'session' } }),
      fileMeta('d', '2026-11-23T17:00:00.000000Z', { scope: null })
    ]
  })
  const result = await handlersWith(store).listFiles()
  expect(result.ok && result.value.map((row) => row.sessionId)).toEqual([null, null, null, null])
})

test('uploads a skill folder in one create call without retry, bounded in time', async () => {
  const created = skill('skill_1', '2026-11-23T20:24:12.647016Z')
  const { store, calls } = fakeStore({ created })
  const result = await handlersWith(store, { skillFolder: readsOk() }).uploadSkill({ folder: '/tmp/my-skill' })
  expect(calls.length).toBe(1)
  expect(calls[0]?.method).toBe('skills.create')
  expect(calls[0]?.args[0]).toEqual({ files: skillFiles })
  const options = calls[0]?.args[1] as { maxRetries: number; timeout: number; signal: AbortSignal }
  expect(options.maxRetries).toBe(0)
  expect(options.timeout).toBe(UPLOAD_TIMEOUT_MS)
  expect(options.signal instanceof AbortSignal).toBe(true)
  expect(result).toEqual({
    ok: true,
    value: {
      id: 'skill_1',
      name: 'name-skill_1',
      latestVersionId: 'skver_skill_1',
      updatedAt: '2026-11-23T20:24:12.647016Z'
    }
  })
})

test('uploads a new version on the same skill id and answers the version id', async () => {
  const { store, calls } = fakeStore({ version: { type: 'skill_version', id: 'skver_2', skill_id: 'skill_1' } })
  const result = await handlersWith(store, { skillFolder: readsOk() }).uploadSkillVersion({
    skillId: 'skill_1',
    folder: '/tmp/my-skill'
  })
  expect(calls.length).toBe(1)
  expect(calls[0]?.method).toBe('skills.versions.create')
  expect(calls[0]?.args[0]).toBe('skill_1')
  expect(calls[0]?.args[1]).toEqual({ files: skillFiles })
  expect((calls[0]?.args[2] as { maxRetries: number }).maxRetries).toBe(0)
  expect(result).toEqual({ ok: true, value: { versionId: 'skver_2' } })
})

test('uploads a file in one call without retry and answers its row', async () => {
  const upload = [new File(['hello'], 'notes.txt')]
  const { store, calls } = fakeStore({ created: fileMeta('file_1', '2026-11-23T20:25:02.693665Z') })
  const result = await handlersWith(store, {
    uploadFile: async () => ({ ok: true, files: upload, label: 'notes.txt' })
  }).uploadFile({ file: '/tmp/notes.txt' })
  expect(calls.length).toBe(1)
  expect(calls[0]?.method).toBe('files.upload')
  expect(calls[0]?.args[0]).toEqual({ file: upload[0] })
  expect((calls[0]?.args[1] as { maxRetries: number }).maxRetries).toBe(0)
  expect(result).toEqual({
    ok: true,
    value: { id: 'file_1', name: 'file_1.txt', sizeBytes: 19, createdAt: '2026-11-23T20:25:02.693665Z', sessionId: null }
  })
})

test('a refused read answers invalid and sends nothing', async () => {
  const { store, calls } = fakeStore()
  const refuse = (error: string) => async (): Promise<ReadUploads> => ({ ok: false, error })
  const handlers = handlersWith(store, { skillFolder: refuse(NO_SKILL_MD), uploadFile: refuse(FILE_TOO_LARGE) })
  expect(await handlers.uploadSkill({ folder: '/x' })).toEqual({ ok: false, code: 'invalid', error: NO_SKILL_MD })
  expect(await handlers.uploadSkillVersion({ skillId: 'skill_1', folder: '/x' })).toEqual({
    ok: false,
    code: 'invalid',
    error: NO_SKILL_MD
  })
  expect(await handlers.uploadFile({ file: '/x' })).toEqual({ ok: false, code: 'invalid', error: FILE_TOO_LARGE })
  expect(calls).toEqual([])
})

test('a workspace switch during the disk read does not move the upload to the new workspace', async () => {
  const started = fakeStore({ created: skill('skill_1', '2026-11-24T08:00:00.000000Z') })
  const switched = fakeStore({ created: skill('skill_2', '2026-11-24T08:00:00.000000Z') })
  let active = started.store
  const store = { get: () => active.get(), reset() {}, hasKey: async () => true } as unknown as ClientStore
  const readThenSwitch = async (): Promise<ReadUploads> => {
    active = switched.store
    return { ok: true, files: skillFiles, label: 'my-skill' }
  }
  const result = await handlersWith(store, { skillFolder: readThenSwitch }).uploadSkill({ folder: '/tmp/my-skill' })
  expect(started.calls.map((call) => call.method)).toEqual(['skills.create'])
  expect(switched.calls).toEqual([])
  expect(result.ok && result.value.id).toBe('skill_1')
})

test('an upload cut before any answer says it may have gone through', async () => {
  const { store, calls } = fakeStore({ uploadError: new TypeError('terminated') })
  const result = await handlersWith(store, { skillFolder: readsOk() }).uploadSkill({ folder: '/tmp/my-skill' })
  expect(result).toEqual({ ok: false, code: 'other', error: UPLOAD_UNCONFIRMED })
  expect(calls.length).toBe(1)
})

test('an upload the API refuses keeps the API text', async () => {
  const refusal = new Anthropic.BadRequestError(
    400,
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          "Skill name 'plugin-test-other' in SKILL.md must be consistent across all versions for a given `skill_id`. Expected 'plugin-test-skill'."
      },
      request_id: 'req_011ChLV7moqTTtZwhK4XWsAd'
    },
    undefined,
    new Headers()
  )
  const { store } = fakeStore({ uploadError: refusal })
  const result = await handlersWith(store, { skillFolder: readsOk() }).uploadSkillVersion({
    skillId: 'skill_1',
    folder: '/tmp/my-skill'
  })
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error.includes(
    "Skill name 'plugin-test-other' in SKILL.md must be consistent across all versions for a given `skill_id`. Expected 'plugin-test-skill'."
  )).toBe(true)
})

test('deletes a skill or a file in one call, without retry', async () => {
  const { store, calls } = fakeStore()
  const handlers = handlersWith(store)
  expect(await handlers.deleteSkill({ skillId: 'skill_1' })).toEqual({ ok: true, value: null })
  expect(await handlers.deleteFile({ fileId: 'file_1' })).toEqual({ ok: true, value: null })
  expect(calls).toEqual([
    { method: 'skills.delete', args: ['skill_1', {}, { maxRetries: 0 }] },
    { method: 'files.delete', args: ['file_1', {}, { maxRetries: 0 }] }
  ])
})
