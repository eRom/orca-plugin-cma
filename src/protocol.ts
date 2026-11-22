// Contrat panneau ↔ worker de la sonde : déclaré une fois, lu par src/panel.tsx et src/worker.ts.

// Un rendu de composants Orca plafonne à environ 512 Kio de données et 16 Kio par texte, une
// réponse de requête à 1 Mio : la sonde ne garde que la fin du fil, en textes courts.
export const ROW_LIMIT = 120
export const TEXT_LIMIT = 1_500

/** Un appel à l'API Anthropic : une erreur revient en texte lisible, jamais en exception. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type AgentRow = {
  id: string
  name: string
  model: string
  version: number
  description: string | null
}

export type SessionRow = {
  id: string
  title: string | null
  status: 'rescheduling' | 'running' | 'idle' | 'terminated'
  agentName: string
  createdAt: string
}

export type StreamPhase = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type StreamState = {
  sessionId: string
  phase: StreamPhase
  /** Début de la phase courante, en millisecondes. */
  since: number
  reconnects: number
  error: string | null
}

/** Un événement de session, réduit à ce que le panneau dessine. */
export type EventRow = {
  id: string
  type: string
  /** `processed_at` ; null tant que l'événement attend derrière d'autres. */
  at: string | null
  text: string
  /** Appel d'outil en pause : la session attend un accord. */
  awaitsApproval: boolean
  /** Pour un `user.tool_confirmation` : l'id de l'appel auquel il répond. */
  answers: string | null
}

/** Texte d'un message en cours de génération, remplacé par son `agent.message` définitif. */
export type Preview = { id: string; text: string }

export type ProbeStatus = {
  hasKey: boolean
  workerStartedAt: number
  stream: StreamState | null
}

export type WatchAnswer = { rows: EventRow[]; stream: StreamState }

declare module 'orca' {
  interface PluginRequests {
    'probe.status': { output: ProbeStatus }
    'key.set': { input: { key: string }; output: ProbeStatus }
    'key.clear': { output: ProbeStatus }
    'agents.list': { output: ApiResult<AgentRow[]> }
    'sessions.list': { output: ApiResult<SessionRow[]> }
    'session.watch': { input: { sessionId: string }; output: ApiResult<WatchAnswer> }
    'session.send': { input: { sessionId: string; text: string }; output: ApiResult<null> }
    'session.confirm': {
      input: { sessionId: string; toolUseId: string; allow: boolean }
      output: ApiResult<null>
    }
    'session.interrupt': { input: { sessionId: string }; output: ApiResult<null> }
  }
  interface PluginPanelEvents {
    'stream.state': StreamState
    /** `previews` est l'état complet des messages en cours, pas un delta. */
    'session.events': { sessionId: string; rows: EventRow[]; previews: Preview[] }
  }
}
