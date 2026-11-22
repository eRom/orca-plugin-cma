import Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsSession } from '@anthropic-ai/sdk/resources/beta/sessions/sessions'
import { expect, test } from 'bun:test'
import { POLL_HIDDEN_MS, POLL_VISIBLE_MS, type SessionRow } from '../protocol'
import { classifyIdle, createPoller, pollInterval, type PollerDeps } from './session-poll'

function fakeSession(over: Partial<BetaManagedAgentsSession>): BetaManagedAgentsSession {
  return {
    id: 'sesn_1',
    agent: { id: 'agent_1', name: 'Writer', version: 1 },
    archived_at: null,
    budget: null,
    created_at: '2026-11-22T10:00:00Z',
    environment_id: 'env_1',
    metadata: {},
    resources: [],
    status: 'idle',
    title: 'Hello',
    updated_at: '2026-11-22T10:05:00Z',
    usage: {},
    vault_ids: [],
    ...over
  } as unknown as BetaManagedAgentsSession
}

type Idle = Awaited<ReturnType<PollerDeps['lastIdle']>>

/** Poller factice : horloge et minuteries pilotées à la main, tout appel noté. */
function harness(options: {
  sessions?: BetaManagedAgentsSession[]
  idle?: Record<string, Idle>
  listError?: unknown
}) {
  let clock = 1_000_000
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const calls = { list: 0, lastIdle: [] as string[] }
  const published: SessionRow[][] = []
  const bars: { text: string; tone: string }[] = []
  const logs: string[] = []
  const state = {
    sessions: options.sessions ?? [],
    listError: options.listError,
    /** Quand présent, le prochain appel de `list` attend cette promesse avant de rendre ses sessions. */
    hold: null as Promise<void> | null
  }
  const deps: PollerDeps = {
    async list() {
      calls.list++
      if (state.listError) throw state.listError
      // Les sessions sont lues à l'appel : un tour retenu rend l'état d'avant le redémarrage.
      const sessions = state.sessions
      const gate = state.hold
      state.hold = null
      if (gate) await gate
      return sessions
    },
    async lastIdle(sessionId) {
      calls.lastIdle.push(sessionId)
      return options.idle?.[sessionId] ?? null
    },
    publish: (rows) => published.push(rows),
    statusBar: (bar) => bars.push({ text: bar.text, tone: bar.tone }),
    log: (message) => logs.push(message),
    now: () => clock,
    schedule(ms, fn) {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  }
  return {
    poller: createPoller(deps),
    state,
    calls,
    published,
    bars,
    logs,
    timers,
    /** Les minuteries encore armées (non annulées, non déclenchées). */
    pending: () => timers.filter((timer) => !timer.cancelled),
    advance: (ms: number) => {
      clock += ms
    },
    clock: () => clock
  }
}

/** Laisse les promesses en attente se résoudre. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const ask = { type: 'agent.mcp_tool_use', evaluatedPermission: 'ask' }
const custom = { type: 'agent.custom_tool_use', evaluatedPermission: null }
const allow = { type: 'agent.tool_use', evaluatedPermission: 'allow' }

test('classifyIdle follows the stop reason', () => {
  const table: [string, Parameters<typeof classifyIdle>, ReturnType<typeof classifyIdle>][] = [
    ['no idle event', [null, []], { badge: 'idle', pendingApprovals: 0 }],
    ['end_turn', [{ type: 'end_turn' }, []], { badge: 'idle', pendingApprovals: 0 }],
    ['budget_reached', [{ type: 'budget_reached' }, []], { badge: 'budget_reached', pendingApprovals: 0 }],
    ['retries_exhausted', [{ type: 'retries_exhausted' }, []], { badge: 'idle', pendingApprovals: 0 }],
    ['refusal', [{ type: 'refusal' }, []], { badge: 'idle', pendingApprovals: 0 }],
    [
      'requires_action with a custom tool',
      [{ type: 'requires_action', event_ids: ['a', 'b'] }, [ask, custom]],
      { badge: 'blocked', pendingApprovals: 1 }
    ],
    [
      'requires_action with two asks',
      [{ type: 'requires_action', event_ids: ['a', 'b'] }, [ask, ask]],
      { badge: 'needs_approval', pendingApprovals: 2 }
    ],
    [
      'requires_action counts event_ids, not only the events found',
      [{ type: 'requires_action', event_ids: ['a', 'b', 'c'] }, [allow]],
      { badge: 'needs_approval', pendingApprovals: 3 }
    ]
  ]
  for (const [name, args, expected] of table) {
    expect([name, classifyIdle(...args)]).toEqual([name, expected])
  }
})

test('pollInterval depends on the last visible ping', () => {
  const now = 100_000
  expect(pollInterval(now - 5_000, now)).toBe(POLL_VISIBLE_MS)
  expect(pollInterval(now - 20_000, now)).toBe(POLL_HIDDEN_MS)
  expect(pollInterval(null, now)).toBe(POLL_HIDDEN_MS)
  expect(POLL_VISIBLE_MS).toBe(10_000)
  expect(POLL_HIDDEN_MS).toBe(60_000)
})

test('counts approvals across sessions', async () => {
  const h = harness({
    sessions: [
      fakeSession({ id: 'sesn_a', title: 'First' }),
      fakeSession({ id: 'sesn_b', title: 'Second' })
    ],
    idle: {
      sesn_a: { stop: { type: 'requires_action', event_ids: ['x'] }, blocking: [ask] },
      sesn_b: { stop: { type: 'requires_action', event_ids: ['y'] }, blocking: [ask] }
    }
  })
  h.poller.start()
  await settle()
  expect(h.bars.at(-1)?.text).toBe('2 approvals')
  expect(h.bars.at(-1)?.tone).toBe('warning')
  expect(h.poller.snapshot().map((row) => row.badge)).toEqual(['needs_approval', 'needs_approval'])
  h.poller.stop()
})

test('only asks events for idle sessions, and only when updated_at changed', async () => {
  const h = harness({
    sessions: [
      fakeSession({ id: 'sesn_run', status: 'running' }),
      fakeSession({ id: 'sesn_idle', status: 'idle', updated_at: '2026-11-22T10:05:00Z' })
    ]
  })
  h.poller.start()
  await settle()
  expect(h.calls.lastIdle).toEqual(['sesn_idle'])
  // Même `updated_at` au tour suivant : le classement est réutilisé.
  h.pending()[0]?.fn()
  await settle()
  expect(h.calls.list).toBe(2)
  expect(h.calls.lastIdle).toEqual(['sesn_idle'])
  // Un nouveau tour de la session : on relit.
  h.state.sessions = [fakeSession({ id: 'sesn_idle', status: 'idle', updated_at: '2026-11-22T10:09:00Z' })]
  h.pending()[0]?.fn()
  await settle()
  expect(h.calls.lastIdle).toEqual(['sesn_idle', 'sesn_idle'])
  h.poller.stop()
})

test('publishes only when the rows changed', async () => {
  const h = harness({ sessions: [fakeSession({ id: 'sesn_a', status: 'running' })] })
  h.poller.start()
  await settle()
  h.pending()[0]?.fn()
  await settle()
  expect(h.calls.list).toBe(2)
  expect(h.published.length).toBe(1)
  h.state.sessions = [fakeSession({ id: 'sesn_a', status: 'terminated' })]
  h.pending()[0]?.fn()
  await settle()
  expect(h.published.length).toBe(2)
  expect(h.published[1]?.[0]?.badge).toBe('terminated')
  h.poller.stop()
})

test('schedules the next turn from the visibility ping', async () => {
  const h = harness({ sessions: [] })
  h.poller.start()
  await settle()
  expect(h.pending().map((timer) => timer.ms)).toEqual([POLL_HIDDEN_MS])
  // Le panneau redevient visible : le prochain tour se rapproche.
  h.advance(5_000)
  h.poller.visible(h.clock())
  expect(h.pending().map((timer) => timer.ms)).toEqual([POLL_VISIBLE_MS - 5_000])
  h.poller.stop()
})

test('poller stops on unauthorized', async () => {
  const h = harness({
    sessions: [],
    listError: new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
  })
  h.poller.start()
  await settle()
  expect(h.bars.at(-1)?.text).toBe('Managed')
  expect(h.published).toEqual([[]])
  expect(h.timers.length).toBe(0)
  expect(h.pending().length).toBe(0)
  expect(h.calls.list).toBe(1)
})

test('poller restarts after start', async () => {
  const h = harness({
    sessions: [fakeSession({ id: 'sesn_a', status: 'running' })],
    listError: new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
  })
  h.poller.start()
  await settle()
  expect(h.timers.length).toBe(0)
  // Une clé corrigée : `start()` relance l'interrogation et la minuterie.
  h.state.listError = undefined
  h.poller.start()
  await settle()
  expect(h.calls.list).toBe(2)
  expect(h.timers.length).toBe(1)
  expect(h.poller.snapshot().map((row) => row.id)).toEqual(['sesn_a'])
  h.poller.stop()
})

test('a transient list error is logged and polling goes on', async () => {
  const h = harness({ sessions: [], listError: new Error('network down') })
  h.poller.start()
  await settle()
  expect(h.logs.length).toBe(1)
  expect(h.pending().length).toBe(1)
  expect(h.published.length).toBe(0)
  h.poller.stop()
})

test('stop resets the status bar and discards a turn still in flight', async () => {
  const h = harness({
    sessions: [fakeSession({ id: 'sesn_a' })],
    idle: { sesn_a: { stop: { type: 'requires_action', event_ids: ['x'] }, blocking: [ask] } }
  })
  h.poller.start()
  h.poller.stop()
  await settle()
  expect(h.bars.at(-1)?.text).toBe('Managed')
  expect(h.published.length).toBe(0)
  expect(h.pending().length).toBe(0)
  expect(h.poller.snapshot()).toEqual([])
})

test('two quick starts arm one timer and publish the rows once', async () => {
  const h = harness({ sessions: [fakeSession({ id: 'sesn_a', status: 'running' })] })
  h.poller.start()
  h.poller.start()
  await settle()
  expect(h.pending().length).toBe(1)
  expect(h.timers.length).toBe(1)
  expect(h.published.length).toBe(1)
  expect(h.published[0]?.map((row) => row.id)).toEqual(['sesn_a'])
  h.poller.stop()
})

test('a turn from before a restart publishes, writes and arms nothing', async () => {
  const h = harness({
    sessions: [fakeSession({ id: 'sesn_old' })],
    idle: { sesn_old: { stop: { type: 'requires_action', event_ids: ['x'] }, blocking: [ask] } }
  })
  let release: () => void = () => {}
  h.state.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  h.poller.start()
  await settle()
  // Le premier tour attend `list` ; on arrête puis on relance avec d'autres sessions.
  h.poller.stop()
  h.state.sessions = [fakeSession({ id: 'sesn_new', status: 'running' })]
  h.poller.start()
  await settle()
  expect(h.published.map((rows) => rows.map((row) => row.id))).toEqual([['sesn_new']])
  expect(h.timers.length).toBe(1)
  const barsBefore = h.bars.length
  // L'ancien tour finit : sa liste d'avant le redémarrage ne doit rien laisser.
  release()
  await settle()
  expect(h.published.map((rows) => rows.map((row) => row.id))).toEqual([['sesn_new']])
  expect(h.bars.length).toBe(barsBefore)
  expect(h.bars.some((bar) => bar.text === '1 approval')).toBe(false)
  expect(h.timers.length).toBe(1)
  expect(h.pending().length).toBe(1)
  expect(h.poller.snapshot().map((row) => row.id)).toEqual(['sesn_new'])
  h.poller.stop()
})

test('a refresh asked during a turn in flight runs one trailing turn that sees the change', async () => {
  const h = harness({ sessions: [fakeSession({ id: 'sesn_a', status: 'running' })] })
  let release: () => void = () => {}
  h.state.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  // Premier tour retenu : il lira `running`.
  const first = h.poller.refresh()
  await settle()
  expect(h.calls.list).toBe(1)
  // La session passe `idle` pendant le tour ; deux appels simultanés partagent le tour de rattrapage.
  h.state.sessions = [fakeSession({ id: 'sesn_a', status: 'idle' })]
  const second = h.poller.refresh()
  const third = h.poller.refresh()
  release()
  await first
  const seen = await second
  await third
  expect(h.calls.list).toBe(2)
  expect(seen.map((row) => row.status)).toEqual(['idle'])
  expect(h.poller.snapshot().map((row) => row.status)).toEqual(['idle'])
})

test('a shared refresh joins the turn in flight without a trailing turn', async () => {
  const h = harness({ sessions: [fakeSession({ id: 'sesn_a', status: 'running' })] })
  let release: () => void = () => {}
  h.state.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = h.poller.refresh()
  await settle()
  const joined = h.poller.refresh({ shared: true })
  release()
  await Promise.all([first, joined])
  expect(h.calls.list).toBe(1)
})

test('a trailing turn queued before a stop is dropped', async () => {
  const h = harness({ sessions: [fakeSession({ id: 'sesn_a', status: 'running' })] })
  let release: () => void = () => {}
  h.state.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  h.poller.start()
  await settle()
  const queued = h.poller.refresh()
  h.poller.stop()
  release()
  await queued
  await settle()
  expect(h.calls.list).toBe(1)
  expect(h.poller.snapshot()).toEqual([])
})
