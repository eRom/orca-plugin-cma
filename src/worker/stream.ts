// Flux en direct d'une session : ouvre le SSE, relit l'historique, dédoublonne, regroupe les envois
// vers le panneau et rouvre le flux après une coupure. Une seule session est suivie à la fois.
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents
} from '@anthropic-ai/sdk/resources/beta/sessions/events'
import {
  accumulateManagedAgentsEvent,
  type AccumulatedEvent
} from '@anthropic-ai/sdk/lib/sessions/accumulate'
import {
  MESSAGE_LIMIT_BYTES,
  THREAD_WINDOW_ROWS,
  type Money,
  type Preview,
  type SessionStatus,
  type StreamPhase,
  type StreamState,
  type ThreadRow,
  type WatchAnswer
} from '../protocol'
import { clipBytesEnd } from '../shared/text'
import { describeError, isFatal, type ClientStore } from './client'
import { applyEvent, createThreadState, rowsBefore, tail, type ThreadState } from './thread'

const FLUSH_MS = 150
/** Plafond d'un envoi vers le panneau, sous la limite du canal. */
const POST_BYTE_BUDGET = 120_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 15_000

export type EventSource = {
  stream(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<BetaManagedAgentsStreamSessionEvents>>
  history(sessionId: string, signal: AbortSignal): AsyncIterable<BetaManagedAgentsSessionEvent>
  status(sessionId: string, signal: AbortSignal): Promise<{ status: SessionStatus; archived: boolean }>
}

export type WatchSink = {
  thread(payload: { sessionId: string; rows: ThreadRow[]; previews: Preview[]; hasEarlier?: boolean }): void
  state(payload: StreamState): void
  usage(sessionId: string, cost: Money | null, budget: Money | null): void
  /** Un changement de statut vu sur le flux en direct (jamais sur la relecture de l'historique). */
  statusChanged(sessionId: string, type: StatusEventType): void
  log(message: string): void
}

export type StatusEventType =
  | 'session.status_running'
  | 'session.status_idle'
  | 'session.status_rescheduled'
  | 'session.status_terminated'

export type Watcher = {
  watch(sessionId: string): WatchAnswer
  leave(sessionId: string): void
  loadEarlier(sessionId: string, beforeId: string): { rows: ThreadRow[]; hasEarlier: boolean } | null
  /** La session que le suivi porte (même terminée), ou null après `leave` ou `stop`. */
  watching(): string | null
  stop(): void
}

export type WatcherOptions = {
  flushMs?: number
  retryMaxMs?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Attente interrompue par l'annulation : la boucle de flux ne dort jamais après un `leave`. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/** Un suivi en cours : tout ce qui meurt avec lui (fil, aperçus, file d'envoi, minuteur). */
type Watch = {
  sessionId: string
  thread: ThreadState
  /** Lignes à poster, dédoublonnées par id (une ligne modifiée remplace sa version en attente). */
  outbox: Map<string, ThreadRow>
  /** Un accumulé par id d'aperçu (message en cours d'écriture). */
  previews: Map<string, AccumulatedEvent>
  previewsDirty: boolean
  /** Vrai dès qu'une relecture de l'historique a abouti (les suivantes ne sont plus la première). */
  replayed: boolean
  /** Valeur de `hasEarlier` à joindre au prochain envoi (relecture initiale), ou null. */
  earlierToSend: boolean | null
  abort: AbortController
  timer: ReturnType<typeof setTimeout> | null
  state: StreamState
}

function toMoney(amount: { amount: string; currency: string } | null | undefined): Money | null {
  return amount ? { minor: amount.amount, currency: amount.currency } : null
}

function previewText(message: AccumulatedEvent): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

function shortId(sessionId: string): string {
  return `${sessionId.slice(0, 10)}…`
}

export function createWatcher(source: EventSource, sink: WatchSink, options: WatcherOptions = {}): Watcher {
  const flushMs = options.flushMs ?? FLUSH_MS
  const retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS
  const sleep = options.sleep ?? abortableSleep
  let current: Watch | null = null

  function setPhase(watch: Watch, phase: StreamPhase, error: string | null = null): void {
    if (watch.abort.signal.aborted) return
    // Les dernières lignes partent avant l'état final : le panneau ne voit jamais `closed` avant elles.
    if (phase === 'closed') flush(watch)
    watch.state = { ...watch.state, phase, since: Date.now(), error }
    sink.state(watch.state)
    sink.log(`stream ${shortId(watch.sessionId)}: ${phase}${error ? ` (${error})` : ''}`)
  }

  function previewsOf(watch: Watch): Preview[] {
    return [...watch.previews].map(([id, message]) => ({
      id,
      text: clipBytesEnd(previewText(message), MESSAGE_LIMIT_BYTES).text
    }))
  }

  function flush(watch: Watch): void {
    if (watch.timer) {
      clearTimeout(watch.timer)
      watch.timer = null
    }
    if (watch.abort.signal.aborted) return
    const rows: ThreadRow[] = []
    let bytes = 0
    for (const [id, row] of watch.outbox) {
      const size = Buffer.byteLength(JSON.stringify(row))
      if (rows.length > 0 && bytes + size > POST_BYTE_BUDGET) break
      rows.push(row)
      watch.outbox.delete(id)
      bytes += size
    }
    if (rows.length > 0 || watch.previewsDirty) {
      watch.previewsDirty = false
      const payload = { sessionId: watch.sessionId, rows, previews: previewsOf(watch) }
      sink.thread(watch.earlierToSend === null ? payload : { ...payload, hasEarlier: watch.earlierToSend })
      watch.earlierToSend = null
    }
    if (watch.outbox.size > 0) scheduleFlush(watch)
  }

  function scheduleFlush(watch: Watch): void {
    watch.timer ??= setTimeout(() => flush(watch), flushMs)
  }

  function enqueue(watch: Watch, rows: ThreadRow[]): void {
    for (const row of rows) watch.outbox.set(row.id, row)
  }

  /** Aperçus de messages : l'accumulé d'un id n'existe qu'entre son `event_start` et son message final. */
  function foldPreview(watch: Watch, event: BetaManagedAgentsStreamSessionEvents): void {
    try {
      if (event.type === 'event_start') {
        const started = accumulateManagedAgentsEvent(undefined, event)
        // Un aperçu de réflexion n'a pas de texte : seul un `agent.message` s'affiche.
        if (started && event.event.type === 'agent.message') watch.previews.set(event.event.id, started)
      } else if (event.type === 'event_delta') {
        const known = watch.previews.get(event.event_id)
        // Un delta sans `event_start` (flux rouvert en plein message) n'a rien à prolonger.
        if (known) watch.previews.set(event.event_id, accumulateManagedAgentsEvent(known, event) ?? known)
      }
      watch.previewsDirty = true
    } catch (error) {
      // Les deltas sont au mieux : le message final reste la référence.
      sink.log(`preview skipped: ${describeError(error).message}`)
    }
  }

  function ingest(watch: Watch, event: BetaManagedAgentsStreamSessionEvents): void {
    if (event.type === 'event_start' || event.type === 'event_delta') {
      foldPreview(watch, event)
    } else {
      if (event.type === 'agent.message') {
        watch.previews.delete(event.id)
        watch.previewsDirty = true
      } else if (event.type === 'span.model_request_end') {
        // Un tour interrompu ne livre jamais son message : on ferme les aperçus restants.
        watch.previews.clear()
        watch.previewsDirty = true
      } else if (event.type === 'session.usage') {
        sink.usage(watch.sessionId, toMoney(event.usage.list_cost), toMoney(event.budget?.max_list_cost))
      } else if (
        event.type === 'session.status_running' ||
        event.type === 'session.status_idle' ||
        event.type === 'session.status_rescheduled' ||
        event.type === 'session.status_terminated'
      ) {
        sink.statusChanged(watch.sessionId, event.type)
      }
      enqueue(watch, applyEvent(watch.thread, event))
    }
    scheduleFlush(watch)
  }

  /**
   * Relit tout l'historique. Tant qu'aucune relecture n'a abouti, seule la fenêtre de fin du fil part,
   * avec `hasEarlier` ; le reste se charge par `loadEarlier`. Ensuite, après une coupure, chaque
   * ligne nouvelle ou modifiée part : un plafond y créerait un trou que `loadEarlier` ne comble pas.
   * `applyEvent` retient les ids au fil de l'eau : une relecture interrompue ne doit donc pas perdre
   * les lignes déjà appliquées (la fenêtre de fin les reprend, ou le `finally` les poste).
   */
  async function replayHistory(watch: Watch, signal: AbortSignal): Promise<void> {
    const firstReplay = !watch.replayed
    const fresh = new Map<string, ThreadRow>()
    try {
      for await (const event of source.history(watch.sessionId, signal)) {
        for (const row of applyEvent(watch.thread, event)) fresh.set(row.id, row)
      }
      if (firstReplay) {
        const page = tail(watch.thread, THREAD_WINDOW_ROWS)
        enqueue(watch, page.rows)
        watch.earlierToSend = page.hasEarlier
        watch.replayed = true
      }
    } finally {
      if (!firstReplay) enqueue(watch, [...fresh.values()])
      watch.previewsDirty = true
      scheduleFlush(watch)
    }
  }

  /** Relecture unique de l'historique après un refus du flux : son échec se note, sans nouvel essai. */
  async function replayAfterRefusal(watch: Watch, signal: AbortSignal): Promise<void> {
    try {
      await replayHistory(watch, signal)
    } catch (error) {
      if (!signal.aborted) sink.log(`history after refusal failed: ${describeError(error).message}`)
    }
  }

  async function follow(watch: Watch): Promise<void> {
    const { signal } = watch.abort
    let delay = 0
    while (!signal.aborted) {
      // Un contrôleur par tentative : le SDK ne ferme un SSE ouvert que depuis son itérateur, donc
      // une tentative qui échoue avant de l'itérer le laisserait ouvert jusqu'au `leave`.
      const attemptAbort = new AbortController()
      const cancelAttempt = (): void => attemptAbort.abort()
      signal.addEventListener('abort', cancelAttempt, { once: true })
      const attemptSignal = attemptAbort.signal
      let openingStream = false
      try {
        // Flux d'abord, historique ensuite : le SSE ne rejoue rien, l'historique comble le trou
        // et le dédoublonnage par id absorbe le recouvrement.
        openingStream = true
        const stream = await source.stream(watch.sessionId, attemptSignal)
        openingStream = false
        // Les aperçus d'une connexion précédente n'ont plus de suite : leurs messages arrivent par l'historique.
        watch.previews.clear()
        watch.previewsDirty = true
        await replayHistory(watch, attemptSignal)
        setPhase(watch, 'open')
        delay = 0
        for await (const event of stream) {
          if (signal.aborted) return
          ingest(watch, event)
          if (event.type === 'session.deleted') {
            setPhase(watch, 'closed', 'This session was deleted.')
            return
          }
          if (event.type === 'session.status_terminated') {
            setPhase(watch, 'closed', 'The session ended.')
            return
          }
        }
        if (signal.aborted) return
        // Le serveur a fermé le flux : on ne le rouvre que si la session vit encore.
        const session = await source.status(watch.sessionId, attemptSignal)
        if (session.status === 'terminated' || session.archived) {
          setPhase(watch, 'closed', 'The session ended.')
          return
        }
      } catch (error) {
        if (signal.aborted) return
        if (isFatal(error)) {
          // Une session terminée ou archivée refuse le flux : son fil reste lisible par l'historique.
          if (openingStream) await replayAfterRefusal(watch, attemptSignal)
          setPhase(watch, 'closed', describeError(error).message)
          return
        }
        watch.state = { ...watch.state, error: describeError(error).message }
      } finally {
        signal.removeEventListener('abort', cancelAttempt)
        attemptAbort.abort()
      }
      if (signal.aborted) return
      watch.state = { ...watch.state, reconnects: watch.state.reconnects + 1 }
      setPhase(watch, 'reconnecting', watch.state.error)
      delay = Math.min(delay === 0 ? RETRY_MIN_MS : delay * 2, retryMaxMs)
      await sleep(delay, signal)
    }
  }

  function stop(): void {
    if (!current) return
    current.abort.abort()
    if (current.timer) clearTimeout(current.timer)
    current = null
  }

  function answerOf(watch: Watch): WatchAnswer {
    const page = tail(watch.thread, THREAD_WINDOW_ROWS)
    return { rows: page.rows, hasEarlier: page.hasEarlier, stream: watch.state }
  }

  return {
    watch(sessionId) {
      if (current && current.sessionId === sessionId && current.state.phase !== 'closed') {
        return answerOf(current)
      }
      stop()
      const watch: Watch = {
        sessionId,
        thread: createThreadState(),
        outbox: new Map(),
        previews: new Map(),
        previewsDirty: false,
        replayed: false,
        earlierToSend: null,
        abort: new AbortController(),
        timer: null,
        state: { sessionId, phase: 'connecting', since: Date.now(), reconnects: 0, error: null }
      }
      current = watch
      sink.state(watch.state)
      sink.log(`stream ${shortId(sessionId)}: connecting`)
      follow(watch).catch((error: unknown) => {
        sink.log(`stream ${shortId(sessionId)}: loop failed (${describeError(error).message})`)
      })
      return { rows: [], hasEarlier: false, stream: watch.state }
    },
    leave(sessionId) {
      if (current?.sessionId === sessionId) stop()
    },
    loadEarlier(sessionId, beforeId) {
      if (!current || current.sessionId !== sessionId) return null
      return rowsBefore(current.thread, beforeId, THREAD_WINDOW_ROWS)
    },
    watching: () => current?.sessionId ?? null,
    stop
  }
}

/** Source réelle : chaque appel relit le client du store, qu'un `key.set` a pu remplacer. */
export function sdkEventSource(store: ClientStore): EventSource {
  return {
    async stream(sessionId, signal) {
      const client = await store.get()
      return client.beta.sessions.events.stream(sessionId, { event_deltas: ['agent.message'] }, { signal })
    },
    history(sessionId, signal) {
      return (async function* () {
        const client = await store.get()
        yield* client.beta.sessions.events.list(sessionId, { order: 'asc' }, { signal })
      })()
    },
    async status(sessionId, signal) {
      const client = await store.get()
      const session = await client.beta.sessions.retrieve(sessionId, undefined, { signal })
      return { status: session.status, archived: session.archived_at !== null }
    }
  }
}
