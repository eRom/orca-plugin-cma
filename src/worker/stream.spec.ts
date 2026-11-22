import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents
} from '@anthropic-ai/sdk/resources/beta/sessions/events'
import { expect, test } from 'bun:test'
import { MESSAGE_LIMIT_BYTES, type Money, type StreamPhase, type StreamState, type ThreadRow } from '../protocol'
import { createWatcher, type EventSource, type WatchSink } from './stream'

const SESSION = 'sesn_test'
const T = '2026-11-22T10:00:00Z'

type StreamEvent = BetaManagedAgentsStreamSessionEvents
type StreamFactory = (signal: AbortSignal) => AsyncIterable<StreamEvent>

function message(id: string): BetaManagedAgentsAgentMessageEvent {
  return { id, type: 'agent.message', content: [{ type: 'text', text: `text of ${id}` }], processed_at: T }
}

/** Source factice : un flux par appel de `stream`, un historique et un statut par appel (le dernier se répète). */
function fakeSource(options: {
  streams: StreamFactory[]
  history?: BetaManagedAgentsSessionEvent[][]
  statuses?: Array<'idle' | 'terminated'>
  streamError?: unknown
  /** Levée par le premier appel de `history` seulement. */
  firstHistoryError?: unknown
}) {
  const calls = { stream: 0, history: 0, status: 0 }
  const signals: AbortSignal[] = []
  /** Pour chaque ouverture de flux, l'état d'annulation des signaux des ouvertures précédentes. */
  const earlierAbortedAtOpen: boolean[][] = []
  const source: EventSource = {
    async stream(_sessionId, signal) {
      const index = calls.stream++
      earlierAbortedAtOpen.push(signals.map((earlier) => earlier.aborted))
      signals.push(signal)
      if (options.streamError) throw options.streamError
      return options.streams[Math.min(index, options.streams.length - 1)](signal)
    },
    history(_sessionId, _signal) {
      const histories = options.history ?? [[]]
      const call = calls.history++
      const events = histories[Math.min(call, histories.length - 1)]
      return (async function* () {
        if (call === 0 && options.firstHistoryError) throw options.firstHistoryError
        yield* events
      })()
    },
    async status() {
      const statuses = options.statuses ?? ['terminated']
      const status = statuses[Math.min(calls.status++, statuses.length - 1)]
      return { status, archived: false }
    }
  }
  return { source, calls, earlierAbortedAtOpen }
}

async function* emit(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  yield* events
}

/** Flux qui rend ses événements puis reste ouvert jusqu'à l'annulation. */
function holdOpen(...events: StreamEvent[]): StreamFactory {
  return async function* (signal) {
    yield* events
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
}

function recordingSink() {
  const threads: Array<{ sessionId: string; rows: ThreadRow[]; previews: Array<{ id: string; text: string }>; hasEarlier?: boolean }> = []
  const states: StreamState[] = []
  const usages: Array<{ cost: Money | null; budget: Money | null }> = []
  const logs: string[] = []
  const waiters: Array<() => void> = []
  const sink: WatchSink = {
    thread: (payload) => {
      threads.push(payload)
      waiters.splice(0).forEach((wake) => wake())
    },
    state: (payload) => {
      states.push(payload)
      waiters.splice(0).forEach((wake) => wake())
    },
    usage: (_sessionId, cost, budget) => usages.push({ cost, budget }),
    log: (line) => logs.push(line)
  }
  /** Attend (sans durée magique) qu'une condition sur ce qui a été posté devienne vraie. */
  async function until(condition: () => boolean): Promise<void> {
    while (!condition()) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  const postedIds = () => threads.flatMap((post) => post.rows.map((row) => row.id))
  const phases = (): StreamPhase[] => states.map((state) => state.phase)
  const closed = () => until(() => states.at(-1)?.phase === 'closed')
  return { sink, threads, states, usages, logs, until, postedIds, phases, closed }
}

const immediate = async () => {}
const options = { flushMs: 0, sleep: immediate }

test('dedupes the history-stream overlap', async () => {
  const { source } = fakeSource({
    streams: [() => emit(message('e2'), message('e3'))],
    history: [[message('e1'), message('e2')]],
    statuses: ['terminated']
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  const ids = recorder.postedIds()
  expect(ids.filter((id) => id === 'e1').length).toBe(1)
  expect(ids.filter((id) => id === 'e2').length).toBe(1)
  expect(ids.filter((id) => id === 'e3').length).toBe(1)
})

test('reconnects after a clean end', async () => {
  const { source, calls } = fakeSource({
    streams: [() => emit(message('e1')), () => emit(message('e2'))],
    history: [[], [message('e1')]],
    statuses: ['idle', 'terminated']
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(recorder.phases()).toEqual(['connecting', 'open', 'reconnecting', 'open', 'closed'])
  expect(recorder.states.at(-1)?.reconnects).toBe(1)
  expect(calls.history).toBe(2)
  const ids = recorder.postedIds()
  expect(ids.filter((id) => id === 'e1').length).toBe(1)
  expect(ids.filter((id) => id === 'e2').length).toBe(1)
})

test('stops on session.deleted', async () => {
  const { source, calls } = fakeSource({
    streams: [() => emit({ id: 'd1', type: 'session.deleted', processed_at: T })]
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(recorder.states.at(-1)?.error).toBe('This session was deleted.')
  expect(calls.stream).toBe(1)
})

test('stops on a fatal error', async () => {
  const error = new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
  const { source, calls } = fakeSource({ streams: [], streamError: error })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(recorder.states.at(-1)?.error).toBe('The API key was rejected (401).')
  expect(calls.stream).toBe(1)
  expect(recorder.phases()).toEqual(['connecting', 'closed'])
})

test('rejoins without a second stream', async () => {
  const { source, calls } = fakeSource({ streams: [holdOpen(message('e1'))] })
  const recorder = recordingSink()
  const watcher = createWatcher(source, recorder.sink, options)
  const first = watcher.watch(SESSION)
  expect(first.rows).toEqual([])
  await recorder.until(() => recorder.postedIds().includes('e1'))
  const second = watcher.watch(SESSION)
  expect(second.rows.map((row) => row.id)).toEqual(['e1'])
  expect(second.stream.phase).toBe('open')
  expect(calls.stream).toBe(1)
  watcher.stop()
})

test('clips a long preview and keeps its end', async () => {
  const chunks = Array.from({ length: 1_000 }, (_, index) => (index === 999 ? 'THE-END-OF-IT-ALL-OK-FOR-40-CHARS-LONG!' : 'x'.repeat(40)))
  const deltas: StreamEvent[] = chunks.map((text) => ({
    type: 'event_delta',
    event_id: 'm1',
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text } }
  }))
  const { source } = fakeSource({
    streams: [() => emit({ type: 'event_start', event: { type: 'agent.message', id: 'm1' } }, ...deltas)]
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  const preview = recorder.threads.at(-1)?.previews.find((candidate) => candidate.id === 'm1')
  expect(preview === undefined).toBe(false)
  expect(new TextEncoder().encode(preview?.text ?? '').length <= MESSAGE_LIMIT_BYTES).toBe(true)
  expect(preview?.text.endsWith('THE-END-OF-IT-ALL-OK-FOR-40-CHARS-LONG!')).toBe(true)
})

test('drops a preview once its agent.message arrives', async () => {
  const { source } = fakeSource({
    streams: [
      () =>
        emit(
          { type: 'event_start', event: { type: 'agent.message', id: 'm1' } },
          { type: 'event_delta', event_id: 'm1', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'par' } } },
          message('m1')
        )
    ]
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(recorder.threads.at(-1)?.previews).toEqual([])
  expect(recorder.postedIds()).toEqual(['m1'])
})

test('reports usage from the stream', async () => {
  const { source } = fakeSource({
    streams: [
      () =>
        emit({
          id: 'u1',
          type: 'session.usage',
          processed_at: T,
          usage: { list_cost: { amount: '250', currency: 'USD' } },
          budget: { type: 'limit', max_list_cost: { amount: '5000', currency: 'USD' } }
        })
    ]
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(recorder.usages).toEqual([
    { cost: { minor: '250', currency: 'USD' }, budget: { minor: '5000', currency: 'USD' } }
  ])
})

test('leave stops posting', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { source } = fakeSource({
    streams: [
      async function* () {
        yield message('e1')
        await gate
        yield message('e2')
      }
    ]
  })
  const recorder = recordingSink()
  const watcher = createWatcher(source, recorder.sink, options)
  watcher.watch(SESSION)
  await recorder.until(() => recorder.postedIds().includes('e1'))
  const postsBefore = recorder.threads.length
  const statesBefore = recorder.states.length
  watcher.leave(SESSION)
  release()
  // Laisse la boucle consommer l'événement émis après le départ.
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  expect(recorder.postedIds().includes('e2')).toBe(false)
  expect(recorder.threads.length).toBe(postsBefore)
  expect(recorder.states.length).toBe(statesBefore)
  expect(watcher.loadEarlier(SESSION, 'e1')).toBe(null)
})

test('watching another session stops the previous one', async () => {
  const { source, calls } = fakeSource({ streams: [holdOpen(message('e1'))] })
  const recorder = recordingSink()
  const watcher = createWatcher(source, recorder.sink, options)
  watcher.watch('sesn_a')
  await recorder.until(() => recorder.postedIds().includes('e1'))
  watcher.watch('sesn_b')
  expect(watcher.loadEarlier('sesn_a', 'e1')).toBe(null)
  expect(calls.stream).toBe(2)
  watcher.stop()
})

test('loadEarlier pages the rows before an id', async () => {
  const history = Array.from({ length: 250 }, (_, index) => message(`h${index}`))
  const { source } = fakeSource({ streams: [holdOpen()], history: [history] })
  const recorder = recordingSink()
  const watcher = createWatcher(source, recorder.sink, options)
  watcher.watch(SESSION)
  await recorder.until(() => recorder.phases().includes('open'))
  const answer = watcher.watch(SESSION)
  expect(answer.rows.length).toBe(100)
  expect(answer.hasEarlier).toBe(true)
  const page = watcher.loadEarlier(SESSION, answer.rows[0].id)
  expect(page?.rows.length).toBe(100)
  expect(page?.hasEarlier).toBe(true)
  watcher.stop()
})

test('closes the stream when history fails', async () => {
  const { source, calls, earlierAbortedAtOpen } = fakeSource({
    streams: [holdOpen(), () => emit()],
    firstHistoryError: new Error('history unavailable'),
    statuses: ['terminated']
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(calls.stream).toBe(2)
  // Le flux de la première tentative est fermé avant que la seconde n'ouvre le sien.
  expect(earlierAbortedAtOpen[1]).toEqual([true])
  expect(recorder.phases()).toEqual(['connecting', 'reconnecting', 'open', 'closed'])
})

test('signals earlier history on the first replay', async () => {
  const history = Array.from({ length: 150 }, (_, index) => message(`h${index}`))
  const { source } = fakeSource({ streams: [() => emit()], history: [history] })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(recorder.threads.some((post) => post.hasEarlier === true)).toBe(true)
  expect(recorder.postedIds().length).toBe(100)
})

test('replays history when the stream is refused', async () => {
  const refused = new Anthropic.BadRequestError(400, undefined, 'session is archived', new Headers())
  const { source, calls } = fakeSource({ streams: [], streamError: refused, history: [[message('e1'), message('e2')]] })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  expect(recorder.postedIds()).toEqual(['e1', 'e2'])
  expect(recorder.states.at(-1)?.phase).toBe('closed')
  expect(recorder.states.at(-1)?.error === null).toBe(false)
  expect(calls.stream).toBe(1)
  expect(calls.history).toBe(1)
})

test('posts every missed row after a reconnect', async () => {
  const first = Array.from({ length: 10 }, (_, index) => message(`old${index}`))
  const missed = Array.from({ length: 150 }, (_, index) => message(`new${index}`))
  const { source } = fakeSource({
    streams: [() => emit(), () => emit()],
    history: [first, [...first, ...missed]],
    statuses: ['idle', 'terminated']
  })
  const recorder = recordingSink()
  createWatcher(source, recorder.sink, options).watch(SESSION)
  await recorder.closed()
  const ids = new Set(recorder.postedIds())
  for (const row of missed) expect(ids.has(row.id)).toBe(true)
  expect(recorder.postedIds().filter((id) => id === 'old0').length).toBe(1)
})
