// Worker de la sonde : le seul côté du plugin qui a le réseau. Il détient la clé, appelle l'API
// Managed Agents et relaie au panneau le flux SSE d'une session.
import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
  EventSendParams
} from '@anthropic-ai/sdk/resources/beta/sessions/events'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  ROW_LIMIT,
  TEXT_LIMIT,
  type AgentRow,
  type ApiResult,
  type EventRow,
  type ProbeStatus,
  type SessionRow,
  type StreamPhase,
  type StreamState
} from './protocol'

const SECRET_NAME = 'anthropic-api-key'
// Un post plafonne à 256 Kio, et Orca en accepte 200 par 10 s : un envoi groupé toutes les
// 150 ms en consomme 67 au plus.
const POST_BYTE_BUDGET = 120_000
const FLUSH_MS = 150
const RETRY_MAX_MS = 15_000

type Watch = {
  sessionId: string
  abort: AbortController
  /** id → `processed_at` déjà relayé : un événement inchangé n'est pas reposté. */
  seen: Map<string, string | null>
  /** Fin du fil, rejouée à un panneau qui se rouvre. */
  rows: EventRow[]
  pending: EventRow[]
  previews: Map<string, string>
  state: StreamState
  timer: ReturnType<typeof setTimeout> | null
}

let watch: Watch | null = null

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'The API key was rejected (401).'
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'This key is not allowed to do that (403).'
  }
  if (error instanceof Anthropic.NotFoundError) {
    return 'Not found (404).'
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Rate limited (429). Try again shortly.'
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach api.anthropic.com.'
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Une erreur que réessayer ne corrigera pas : la boucle de flux s'arrête dessus. */
function isFatal(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.BadRequestError
  )
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT
    ? `${text.slice(0, TEXT_LIMIT)}\n[+${text.length - TEXT_LIMIT} chars]`
    : text
}

function textOf(blocks: readonly { type: string }[] | undefined): string {
  return (blocks ?? [])
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : `[${block.type}]`))
    .join('\n')
}

function toRow(event: BetaManagedAgentsSessionEvent): EventRow {
  const base = {
    id: event.id,
    type: event.type,
    at: event.processed_at ?? null,
    text: '',
    awaitsApproval: false,
    answers: null
  }
  switch (event.type) {
    case 'agent.message':
    case 'user.message':
      return { ...base, text: clip(textOf(event.content)) }
    case 'agent.tool_use':
      return {
        ...base,
        text: clip(`${event.name} ${JSON.stringify(event.input)}`),
        awaitsApproval: event.evaluated_permission === 'ask'
      }
    case 'agent.mcp_tool_use':
      return {
        ...base,
        text: clip(`${event.mcp_server_name}.${event.name} ${JSON.stringify(event.input)}`),
        awaitsApproval: event.evaluated_permission === 'ask'
      }
    case 'agent.tool_result':
    case 'agent.mcp_tool_result':
      return { ...base, text: clip(`${event.is_error ? 'error: ' : ''}${textOf(event.content)}`) }
    case 'user.tool_confirmation':
      return { ...base, text: event.result, answers: event.tool_use_id }
    case 'session.status_idle':
      return { ...base, text: event.stop_reason.type }
    case 'session.error':
      return { ...base, text: clip(`${event.error.type}: ${event.error.message}`) }
    case 'session.usage': {
      const cost = event.usage.list_cost
      // Le montant arrive en centimes, sous forme de chaîne entière.
      return { ...base, text: cost ? `${(Number(cost.amount) / 100).toFixed(2)} ${cost.currency}` : '' }
    }
    default:
      return base
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const startedAt = Date.now()
  let client: Anthropic | null = null

  async function api(): Promise<Anthropic> {
    if (client) {
      return client
    }
    const key = await orca.secrets.get(SECRET_NAME)
    if (!key) {
      throw new Error('Add your Anthropic API key first.')
    }
    client = new Anthropic({ apiKey: key })
    return client
  }

  async function attempt<T>(run: (anthropic: Anthropic) => Promise<T>): Promise<ApiResult<T>> {
    try {
      return { ok: true, value: await run(await api()) }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  async function status(): Promise<ProbeStatus> {
    return {
      hasKey: (await orca.secrets.get(SECRET_NAME)) !== null,
      workerStartedAt: startedAt,
      stream: watch?.state ?? null
    }
  }

  function awaitingCount(current: Watch): number {
    const answered = new Set(current.rows.map((row) => row.answers))
    return current.rows.filter((row) => row.awaitsApproval && !answered.has(row.id)).length
  }

  function showInStatusBar(current: Watch | null): void {
    const waiting = current ? awaitingCount(current) : 0
    const phase = current?.state.phase ?? 'closed'
    const text =
      waiting > 0 ? `Managed: needs you (${waiting})` : phase === 'open' ? 'Managed: live' : 'Managed'
    orca.host
      .call('statusBar.update', {
        id: 'stream',
        text,
        tone: waiting > 0 ? 'warning' : phase === 'open' ? 'success' : 'neutral',
        tooltip: current
          ? `Claude Managed Agents: ${current.sessionId} is ${phase}`
          : 'Claude Managed Agents: no session followed'
      })
      // La barre d'état n'existe que dans l'app desktop : un refus se note, sans casser le flux.
      .catch((error: unknown) => orca.log(`statusBar.update refused: ${describeError(error)}`))
  }

  function setPhase(current: Watch, phase: StreamPhase, error: string | null = null): void {
    current.state = { ...current.state, phase, since: Date.now(), error }
    orca.panels.post('stream.state', current.state)
    showInStatusBar(current)
    orca.log(`stream ${current.sessionId}: ${phase}${error ? ` (${error})` : ''}`)
  }

  function flush(current: Watch): void {
    current.timer = null
    const batch: EventRow[] = []
    let bytes = 0
    while (current.pending.length > 0) {
      const size = Buffer.byteLength(JSON.stringify(current.pending[0]))
      if (batch.length > 0 && bytes + size > POST_BYTE_BUDGET) {
        break
      }
      batch.push(...current.pending.splice(0, 1))
      bytes += size
    }
    orca.panels.post('session.events', {
      sessionId: current.sessionId,
      rows: batch,
      previews: [...current.previews].map(([id, text]) => ({ id, text: text.slice(-TEXT_LIMIT) }))
    })
    showInStatusBar(current)
    if (current.pending.length > 0) {
      scheduleFlush(current)
    }
  }

  function scheduleFlush(current: Watch): void {
    current.timer ??= setTimeout(() => flush(current), FLUSH_MS)
  }

  /** Range un événement dans le fil ; rend sa ligne si elle est nouvelle ou a changé. */
  function record(current: Watch, event: BetaManagedAgentsSessionEvent): EventRow | null {
    const row = toRow(event)
    // Un événement envoyé par le client passe deux fois : en file (`at` null), puis traité.
    if (current.seen.has(row.id) && current.seen.get(row.id) === row.at) {
      return null
    }
    current.seen.set(row.id, row.at)
    const index = current.rows.findIndex((known) => known.id === row.id)
    if (index >= 0) {
      current.rows[index] = row
    } else {
      current.rows.push(row)
      current.rows.splice(0, Math.max(0, current.rows.length - ROW_LIMIT))
    }
    return row
  }

  function ingest(current: Watch, event: BetaManagedAgentsStreamSessionEvents): void {
    if (event.type === 'event_start') {
      current.previews.set(event.event.id, '')
    } else if (event.type === 'event_delta') {
      const written = current.previews.get(event.event_id) ?? ''
      current.previews.set(event.event_id, written + event.delta.content.text)
    } else {
      if (event.type === 'agent.message') {
        current.previews.delete(event.id)
      } else if (event.type === 'span.model_request_end') {
        // Un tour interrompu ne livre jamais son message : on ferme les aperçus restants.
        current.previews.clear()
      }
      const row = record(current, event)
      if (row) {
        current.pending.push(row)
      }
    }
    scheduleFlush(current)
  }

  async function follow(anthropic: Anthropic, current: Watch): Promise<void> {
    const { signal } = current.abort
    let delay = 0
    while (!signal.aborted) {
      try {
        // Flux d'abord, historique ensuite : le SSE ne rejoue rien, l'historique comble le trou
        // et le dédoublonnage par id absorbe le recouvrement.
        const stream = await anthropic.beta.sessions.events.stream(
          current.sessionId,
          { event_deltas: ['agent.message'] },
          { signal }
        )
        const fresh: EventRow[] = []
        for await (const event of anthropic.beta.sessions.events.list(
          current.sessionId,
          { order: 'asc' },
          { signal }
        )) {
          const row = record(current, event)
          if (row) {
            fresh.push(row)
          }
        }
        current.pending.push(...fresh.slice(-ROW_LIMIT))
        scheduleFlush(current)
        setPhase(current, 'open')
        delay = 0
        for await (const event of stream) {
          ingest(current, event)
          if (event.type === 'session.status_terminated' || event.type === 'session.deleted') {
            setPhase(current, 'closed', 'The session ended.')
            return
          }
        }
        // Le serveur a fermé le flux : on ne le rouvre que si la session vit encore.
        const session = await anthropic.beta.sessions.retrieve(current.sessionId, undefined, { signal })
        if (session.status === 'terminated' || session.archived_at !== null) {
          setPhase(current, 'closed', 'The session ended.')
          return
        }
      } catch (error) {
        if (signal.aborted) {
          return
        }
        if (isFatal(error)) {
          setPhase(current, 'closed', describeError(error))
          return
        }
        current.state = { ...current.state, error: describeError(error) }
      }
      if (signal.aborted) {
        return
      }
      current.state = { ...current.state, reconnects: current.state.reconnects + 1 }
      setPhase(current, 'reconnecting', current.state.error)
      delay = Math.min(delay === 0 ? 1_000 : delay * 2, RETRY_MAX_MS)
      await sleep(delay, signal)
    }
  }

  function stopWatch(): void {
    if (!watch) {
      return
    }
    watch.abort.abort()
    if (watch.timer) {
      clearTimeout(watch.timer)
    }
    watch = null
    showInStatusBar(null)
  }

  function send(sessionId: string, event: EventSendParams['events'][number]) {
    return attempt(async (anthropic) => {
      await anthropic.beta.sessions.events.send(sessionId, { events: [event] })
      return null
    })
  }

  orca.panels.handle('probe.status', status)

  orca.panels.handle('key.set', async ({ key }) => {
    await orca.secrets.set(SECRET_NAME, key.trim())
    client = null
    stopWatch()
    return status()
  })

  orca.panels.handle('key.clear', async () => {
    await orca.secrets.delete(SECRET_NAME)
    client = null
    stopWatch()
    return status()
  })

  orca.panels.handle('agents.list', () =>
    attempt(async (anthropic) => {
      const page = await anthropic.beta.agents.list({ limit: 50 })
      return page.data.map(
        (agent): AgentRow => ({
          id: agent.id,
          name: agent.name,
          model: agent.model.id,
          version: agent.version,
          description: agent.description
        })
      )
    })
  )

  orca.panels.handle('sessions.list', () =>
    attempt(async (anthropic) => {
      const page = await anthropic.beta.sessions.list({ limit: 20, order: 'desc' })
      return page.data.map(
        (session): SessionRow => ({
          id: session.id,
          title: session.title,
          status: session.status,
          agentName: session.agent.name,
          createdAt: session.created_at
        })
      )
    })
  )

  orca.panels.handle('session.watch', ({ sessionId }) =>
    attempt(async (anthropic) => {
      // Un panneau qui se rouvre retrouve le flux en cours et la fin du fil, sans rien relancer.
      if (watch && watch.sessionId === sessionId && watch.state.phase !== 'closed') {
        return { rows: watch.rows, stream: watch.state }
      }
      stopWatch()
      const next: Watch = {
        sessionId,
        abort: new AbortController(),
        seen: new Map(),
        rows: [],
        pending: [],
        previews: new Map(),
        state: { sessionId, phase: 'connecting', since: Date.now(), reconnects: 0, error: null },
        timer: null
      }
      watch = next
      showInStatusBar(next)
      follow(anthropic, next).catch((error: unknown) =>
        orca.log(`stream ${sessionId} crashed: ${describeError(error)}`)
      )
      return { rows: [], stream: next.state }
    })
  )

  orca.panels.handle('session.send', ({ sessionId, text }) =>
    send(sessionId, { type: 'user.message', content: [{ type: 'text', text }] })
  )

  orca.panels.handle('session.confirm', ({ sessionId, toolUseId, allow }) =>
    send(sessionId, {
      type: 'user.tool_confirmation',
      tool_use_id: toolUseId,
      result: allow ? 'allow' : 'deny'
    })
  )

  orca.panels.handle('session.interrupt', ({ sessionId }) => send(sessionId, { type: 'user.interrupt' }))

  // Diagnostic : ce qu'une clé apprend d'elle-même (organisation, en-têtes de réponse, workspaces).
  orca.panels.handle('probe.whoami', () =>
    attempt(async (anthropic) => {
      const rawError = (error: unknown): string =>
        error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : String(error)
      const describe = ({ data, response }: { data: unknown; response: Response }) => ({
        data,
        headerNames: [...response.headers.keys()],
        identityHeaders: Object.fromEntries(
          [...response.headers].filter(([name]) => /organization|workspace/i.test(name))
        )
      })
      const agentsCall = await anthropic.beta.agents.list({ limit: 1 }).withResponse()
      const workspaceId = agentsCall.response.headers.get('anthropic-workspace-id')
      return {
        organization: await anthropic.beta.organization.retrieve().withResponse().then(describe, rawError),
        agents: describe({ data: null, response: agentsCall.response }),
        ownWorkspace: workspaceId
          ? await anthropic.beta.organization.workspaces.retrieve(workspaceId).catch(rawError)
          : 'no anthropic-workspace-id header',
        workspaces: await anthropic.beta.organization.workspaces
          .list({ limit: 20 })
          .then((page) => page.data.map((workspace) => `${workspace.id} ${workspace.name}`), rawError)
      }
    })
  )

  orca.log('agent-claude-managed probe worker ready')
}

export function deactivate(): void {
  watch?.abort.abort()
}
