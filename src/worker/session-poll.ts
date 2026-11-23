// Interrogation périodique des sessions : classe les sessions `idle` (accords en attente, budget
// atteint...), calcule la cadence selon la visibilité du panneau et alimente la barre d'état.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsSession } from '@anthropic-ai/sdk/resources/beta/sessions/sessions'
import { POLL_HIDDEN_MS, POLL_VISIBLE_MS, type ApiResult, type ResourceRef, type SessionRow } from '../protocol'
import { statusBarText } from '../shared/sessions'
import { describeError, type ClientStore } from './client'
import { toSessionRow, type IdleClassification } from './session-actions'

/** Un ping de visibilité plus récent que cela garde la cadence rapide. */
const VISIBLE_WINDOW_MS = 15_000
/** Nombre maximal de sessions suivies. */
const MAX_SESSIONS = 200
/** Nombre de sessions `idle` dont on relit les événements en parallèle. */
const IDLE_CONCURRENCY = 5

type StopReason = { type: string; event_ids?: readonly string[] }
type BlockingEvent = { type: string; evaluatedPermission: string | null }
type LastIdle = { stop: StopReason | null; blocking: readonly BlockingEvent[] }
type StatusBar = ReturnType<typeof statusBarText>

/** Badge et nombre d'accords d'une session `idle`, d'après la raison de son dernier arrêt. */
export function classifyIdle(stop: StopReason | null, blocking: readonly BlockingEvent[]): IdleClassification {
  if (stop?.type === 'budget_reached') {
    return { badge: 'budget_reached', pendingApprovals: 0 }
  }
  if (stop?.type !== 'requires_action') {
    // Aucun arrêt connu, `end_turn`, `retries_exhausted` et `refusal` : la session attend simplement.
    return { badge: 'idle', pendingApprovals: 0 }
  }
  // Un outil personnalisé attend un résultat que le panneau ne sait pas fournir : la session est bloquée.
  if (blocking.some((event) => event.type === 'agent.custom_tool_use')) {
    return { badge: 'blocked', pendingApprovals: blocking.filter((event) => event.evaluatedPermission === 'ask').length }
  }
  return { badge: 'needs_approval', pendingApprovals: stop.event_ids?.length ?? 0 }
}

/** Délai avant le prochain tour : rapide tant que le panneau a pingé il y a moins de 15 s. */
export function pollInterval(lastVisiblePingAt: number | null, now: number): number {
  return lastVisiblePingAt !== null && now - lastVisiblePingAt < VISIBLE_WINDOW_MS ? POLL_VISIBLE_MS : POLL_HIDDEN_MS
}

export type PollerDeps = {
  list(): Promise<BetaManagedAgentsSession[]>
  /** Dernier arrêt d'une session `idle` ; null quand elle n'en a aucun. */
  lastIdle(sessionId: string): Promise<LastIdle | null>
  publish(rows: SessionRow[]): void
  statusBar(text: StatusBar): void
  log(message: string): void
  now(): number
  /** Arme une minuterie unique ; l'appel rendu l'annule. */
  schedule(ms: number, fn: () => void): () => void
}

export type Poller = {
  /** (Re)lance l'interrogation : un premier tour tout de suite, puis un tour par intervalle. */
  start(): void
  /** Ping du panneau visible, à l'instant `at` : rapproche le prochain tour si besoin. */
  visible(at: number): void
  snapshot(): SessionRow[]
  /**
   * Un tour à la demande ; lève l'erreur de l'API. Appelé pendant qu'un tour tourne, il n'adopte pas ce
   * tour (sa lecture a pu précéder le changement qui motive l'appel) : un seul tour de rattrapage suit,
   * partagé par tous les appelants du moment. Avec `shared`, l'appelant n'attend aucun changement
   * précis et adopte le tour en cours.
   */
  refresh(options?: { shared?: boolean }): Promise<SessionRow[]>
  /** Arrête, oublie l'instantané et remet la barre d'état à `Managed`. */
  stop(): void
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Anthropic.AuthenticationError
}

export function createPoller(deps: PollerDeps): Poller {
  // Chaque arrêt ou redémarrage change d'époque : un tour commencé avant est jeté à son retour.
  let epoch = 0
  let running = false
  let cancelTimer: (() => void) | null = null
  let armedAt = 0
  let dueAt = 0
  let inflight: Promise<SessionRow[]> | null = null
  /** Le tour de rattrapage en attente de la fin du tour en cours ; un seul à la fois. */
  let trailing: Promise<SessionRow[]> | null = null
  let lastVisibleAt: number | null = null
  let rows: SessionRow[] = []
  let published: string | null = null
  let barSent: string | null = null
  const idleCache = new Map<string, { updatedAt: string; idle: IdleClassification }>()

  function sendBar(bar: StatusBar): void {
    const serialized = JSON.stringify(bar)
    if (serialized !== barSent) {
      barSent = serialized
      deps.statusBar(bar)
    }
  }

  function halt(): void {
    epoch++
    running = false
    cancelTimer?.()
    cancelTimer = null
    inflight = null
    trailing = null
    rows = []
    published = null
    idleCache.clear()
  }

  async function classify(session: BetaManagedAgentsSession): Promise<SessionRow> {
    if (session.status !== 'idle') {
      idleCache.delete(session.id)
      return toSessionRow(session, null)
    }
    const cached = idleCache.get(session.id)
    if (cached && cached.updatedAt === session.updated_at) {
      return toSessionRow(session, cached.idle)
    }
    try {
      const last = await deps.lastIdle(session.id)
      const idle = classifyIdle(last?.stop ?? null, last?.blocking ?? [])
      idleCache.set(session.id, { updatedAt: session.updated_at, idle })
      return toSessionRow(session, idle)
    } catch (error) {
      if (isUnauthorized(error)) {
        throw error
      }
      // Une session illisible ne fait pas perdre la liste : elle reste `idle` et sera relue au tour suivant.
      deps.log(`idle events of ${session.id} unreadable: ${error instanceof Error ? error.message : String(error)}`)
      return toSessionRow(session, null)
    }
  }

  async function turn(): Promise<SessionRow[]> {
    const mine = epoch
    const sessions = await deps.list()
    const next: SessionRow[] = []
    for (let from = 0; from < sessions.length; from += IDLE_CONCURRENCY) {
      next.push(...(await Promise.all(sessions.slice(from, from + IDLE_CONCURRENCY).map(classify))))
    }
    if (mine !== epoch) {
      return rows
    }
    const listed = new Set(sessions.map((session) => session.id))
    for (const id of idleCache.keys()) {
      if (!listed.has(id)) idleCache.delete(id)
    }
    rows = next
    sendBar(statusBarText(rows))
    const serialized = JSON.stringify(rows)
    if (serialized !== published) {
      published = serialized
      deps.publish(rows)
    }
    return rows
  }

  function refresh(options: { shared?: boolean } = {}): Promise<SessionRow[]> {
    if (inflight) {
      if (options.shared) {
        return inflight
      }
      if (trailing) {
        return trailing
      }
      const asked = epoch
      const queued: Promise<SessionRow[]> = inflight
        .then(
          () => undefined,
          () => undefined
        )
        .then(() => {
          if (trailing === queued) trailing = null
          // Un arrêt ou un redémarrage entre-temps a jeté le tour en cours : celui-ci n'a plus d'objet.
          if (asked !== epoch) return rows
          // Un tour parti depuis la fin du tour attendu a lu après la demande : on l'adopte plutôt que d'en doubler un.
          return inflight ?? startTurn()
        })
      trailing = queued
      return queued
    }
    return startTurn()
  }

  function startTurn(): Promise<SessionRow[]> {
    const mine = epoch
    const current: Promise<SessionRow[]> = turn()
      .catch((error: unknown) => {
        if (mine === epoch && isUnauthorized(error)) {
          // Clé refusée : inutile d'insister. Le panneau relit `workspace.info` et remontre le formulaire.
          halt()
          sendBar(statusBarText([]))
          deps.publish([])
        }
        throw error
      })
      .finally(() => {
        if (inflight === current) inflight = null
      })
    inflight = current
    return current
  }

  function arm(): void {
    const delay = pollInterval(lastVisibleAt, deps.now())
    armedAt = deps.now()
    dueAt = armedAt + delay
    cancelTimer = deps.schedule(delay, loop)
  }

  function loop(): void {
    cancelTimer = null
    const mine = epoch
    refresh({ shared: true })
      .catch((error: unknown) => {
        // Pas de clé ou clé refusée : rien d'anormal à journaliser, le panneau le montre déjà.
        const { code, message } = describeError(error)
        if (code !== 'unauthorized' && code !== 'no_key') {
          deps.log(`session poll failed: ${message}`)
        }
      })
      .then(() => {
        if (mine === epoch && running) arm()
      })
  }

  return {
    start() {
      halt()
      running = true
      loop()
    },
    visible(at) {
      lastVisibleAt = at
      if (!running || cancelTimer === null) {
        return
      }
      // Le panneau redevient visible alors qu'un long délai court : on le ramène à la cadence rapide.
      const sooner = armedAt + pollInterval(at, deps.now())
      if (sooner < dueAt) {
        cancelTimer()
        dueAt = sooner
        cancelTimer = deps.schedule(Math.max(0, sooner - deps.now()), loop)
      }
    },
    snapshot: () => rows,
    refresh,
    stop() {
      halt()
      barSent = null
      sendBar(statusBarText([]))
    }
  }
}

/** Les appels réels : chaque appel relit le client du store, qu'une bascule de workspace ou un remplacement de clé a pu remplacer. */
export function sdkPollSource(store: ClientStore): Pick<PollerDeps, 'list' | 'lastIdle'> {
  return {
    async list() {
      const client = await store.get()
      // Jusqu'à 200 sessions non archivées, les plus récentes d'abord. L'API plafonne une page à 100
      // (400 observé le 22/11 avec `limit: 200`) : deux pages, puis on s'arrête.
      const sessions: BetaManagedAgentsSession[] = []
      for await (const session of client.beta.sessions.list({ limit: 100, order: 'desc' })) {
        sessions.push(session)
        if (sessions.length >= MAX_SESSIONS) break
      }
      return sessions
    },

    async lastIdle(sessionId) {
      const client = await store.get()
      // Première page seulement : `for await` parcourrait tout l'historique de la session.
      const idle = (
        await client.beta.sessions.events.list(sessionId, { types: ['session.status_idle'], order: 'desc', limit: 1 })
      ).data[0]
      if (idle?.type !== 'session.status_idle') {
        return null
      }
      const stop = idle.stop_reason
      if (stop.type !== 'requires_action') {
        return { stop, blocking: [] }
      }
      const events = (
        await client.beta.sessions.events.list(sessionId, {
          types: ['agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use'],
          order: 'desc',
          limit: 50
        })
      ).data
      const blockingIds = new Set(stop.event_ids)
      const blocking: BlockingEvent[] = []
      for (const event of events) {
        if (!blockingIds.has(event.id)) continue
        if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') {
          blocking.push({ type: event.type, evaluatedPermission: event.evaluated_permission ?? null })
        } else if (event.type === 'agent.custom_tool_use') {
          blocking.push({ type: event.type, evaluatedPermission: null })
        }
      }
      return { stop, blocking }
    }
  }
}

/**
 * Archiver ou supprimer une session change la liste que le sondeur porte : on la relit AVANT de répondre au
 * panneau, qui relit `sessions.list` dès sa réponse (sans cela il revoit un instant la session retirée).
 * Un échec de la relecture se note seulement : l'archivage ou la suppression a réussi.
 */
export function thenSettleSessions(
  handler: (ref: ResourceRef) => Promise<ApiResult<null>>,
  poller: Pick<Poller, 'refresh'>,
  log: (message: string) => void
): (ref: ResourceRef) => Promise<ApiResult<null>> {
  return async (ref) => {
    const result = await handler(ref)
    if (result.ok && ref.kind === 'session') {
      try {
        await poller.refresh()
      } catch (error) {
        log(`sessions refresh failed: ${describeError(error).message}`)
      }
    }
    return result
  }
}
