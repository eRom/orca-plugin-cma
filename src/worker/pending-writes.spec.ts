import { expect, test } from 'bun:test'
import { CHANGES_RENDER_CAP, type ApiResult, type Committed, type FieldChange } from '../protocol'
import { PENDING_TTL_MS, createPendingWrites } from './pending-writes'

const change = (path: string): FieldChange => ({ path, before: '1', after: '2', lines: null })
const committed: ApiResult<Committed> = { ok: true, value: { label: 'Saved' } }
const EXPIRED = { ok: false, code: 'expired', error: 'This review expired: press Apply again.' }

function setup() {
  const clock = { now: 1_000 }
  const calls: boolean[] = []
  const pending = createPendingWrites(() => clock.now)
  return { clock, calls, pending }
}

test('stage returns the changes with a token and a total', () => {
  const { pending } = setup()
  const prepared = pending.stage(async () => committed, [change('a'), change('b')], true)
  expect(prepared.changes).toEqual([change('a'), change('b')])
  expect(prepared.totalChanges).toBe(2)
  expect(prepared.creates).toBe(true)
  expect(prepared.token.length > 0).toBe(true)
})

test('stage hands out a distinct token each time', () => {
  const { pending } = setup()
  const first = pending.stage(async () => committed, [], false)
  const second = pending.stage(async () => committed, [], false)
  expect(first.token === second.token).toBe(false)
})

test('stage caps the rendered changes and keeps the real total', () => {
  const { pending } = setup()
  const many = Array.from({ length: CHANGES_RENDER_CAP + 50 }, (_, index) => change(`field${index}`))
  const prepared = pending.stage(async () => committed, many, false)
  expect(prepared.changes.length).toBe(CHANGES_RENDER_CAP)
  expect(prepared.totalChanges).toBe(CHANGES_RENDER_CAP + 50)
})

test('commit of an unknown token is expired', async () => {
  const { pending } = setup()
  expect(await pending.commit('unknown', false)).toEqual(EXPIRED)
})

test('commit runs the staged write with the force flag and consumes the token on success', async () => {
  const { pending, calls } = setup()
  const prepared = pending.stage(async (force) => (calls.push(force), committed), [change('a')], false)
  expect(await pending.commit(prepared.token, false)).toEqual(committed)
  expect(calls).toEqual([false])
  expect(await pending.commit(prepared.token, false)).toEqual(EXPIRED)
  expect(calls).toEqual([false])
})

test('commit of a token older than the time to live is expired and never runs the write', async () => {
  const { pending, clock, calls } = setup()
  const prepared = pending.stage(async (force) => (calls.push(force), committed), [change('a')], false)
  clock.now += PENDING_TTL_MS + 1
  expect(await pending.commit(prepared.token, false)).toEqual(EXPIRED)
  expect(calls).toEqual([])
})

test('commit right at the time to live still works', async () => {
  const { pending, clock } = setup()
  const prepared = pending.stage(async () => committed, [change('a')], false)
  clock.now += PENDING_TTL_MS
  expect(await pending.commit(prepared.token, false)).toEqual(committed)
})

test('a failed commit keeps the token so a forced retry goes through', async () => {
  const { pending, calls } = setup()
  const prepared = pending.stage(
    async (force) => {
      calls.push(force)
      return force ? committed : { ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it.' }
    },
    [change('a')],
    false
  )
  expect(await pending.commit(prepared.token, false)).toEqual({
    ok: false,
    code: 'conflict',
    error: 'Changed elsewhere since you opened it.'
  })
  expect(await pending.commit(prepared.token, true)).toEqual(committed)
  expect(calls).toEqual([false, true])
  expect(await pending.commit(prepared.token, true)).toEqual(EXPIRED)
})

test('two simultaneous commits of one token run the write once and share its result', async () => {
  const { pending, calls } = setup()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const prepared = pending.stage(
    async (force) => {
      calls.push(force)
      await gate
      return committed
    },
    [change('a')],
    true
  )
  const first = pending.commit(prepared.token, false)
  // Un second appel pendant le vol, même avec `force`, partage le résultat en cours.
  const second = pending.commit(prepared.token, true)
  release()
  expect(await first).toEqual(committed)
  expect(await second).toEqual(committed)
  expect(calls).toEqual([false])
  expect(await pending.commit(prepared.token, false)).toEqual(EXPIRED)
})

test('after a failed in-flight commit a later forced commit still works', async () => {
  const { pending, calls } = setup()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const refused: ApiResult<Committed> = { ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it.' }
  const prepared = pending.stage(
    async (force) => {
      calls.push(force)
      if (force) return committed
      await gate
      return refused
    },
    [change('a')],
    false
  )
  const first = pending.commit(prepared.token, false)
  const second = pending.commit(prepared.token, false)
  release()
  expect(await first).toEqual(refused)
  expect(await second).toEqual(refused)
  expect(calls).toEqual([false])
  expect(await pending.commit(prepared.token, true)).toEqual(committed)
  expect(calls).toEqual([false, true])
})

test('a commit that throws frees the token for another attempt', async () => {
  const { pending, calls } = setup()
  const prepared = pending.stage(
    async (force) => {
      calls.push(force)
      if (calls.length === 1) throw new Error('boom')
      return committed
    },
    [change('a')],
    false
  )
  let thrown = false
  try {
    await pending.commit(prepared.token, false)
  } catch {
    thrown = true
  }
  expect(thrown).toBe(true)
  expect(await pending.commit(prepared.token, false)).toEqual(committed)
})

test('expired entries are dropped when a new write is staged', async () => {
  const { pending, clock, calls } = setup()
  const old = pending.stage(async (force) => (calls.push(force), committed), [], false)
  clock.now += PENDING_TTL_MS + 1
  pending.stage(async () => committed, [], false)
  expect(await pending.commit(old.token, false)).toEqual(EXPIRED)
})

test('two staged writes commit independently', async () => {
  const { pending } = setup()
  const first = pending.stage(async () => ({ ok: true, value: { label: 'First' } }), [], false)
  const second = pending.stage(async () => ({ ok: true, value: { label: 'Second' } }), [], false)
  expect(await pending.commit(second.token, false)).toEqual({ ok: true, value: { label: 'Second' } })
  expect(await pending.commit(first.token, false)).toEqual({ ok: true, value: { label: 'First' } })
})

test('clear drops every staged write', async () => {
  const { pending, calls } = setup()
  const first = pending.stage(async (force) => (calls.push(force), committed), [change('a')], false)
  const second = pending.stage(async (force) => (calls.push(force), committed), [change('b')], false)
  pending.clear()
  expect(await pending.commit(first.token, false)).toEqual(EXPIRED)
  expect(await pending.commit(second.token, true)).toEqual(EXPIRED)
  expect(calls).toEqual([])
})
