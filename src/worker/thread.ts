// Réduction pure des événements de session (SDK 1.8.0) en lignes du fil du panneau.
// Aucun réseau : le worker pousse les événements ici et lit les lignes nouvelles ou modifiées.
import type { BetaManagedAgentsSessionEvent } from '@anthropic-ai/sdk/resources/beta/sessions/events'
import {
  MESSAGE_LIMIT_BYTES,
  THREAD_WINDOW_BYTES,
  TOOL_IO_LIMIT_BYTES,
  type ClippedText,
  type ThreadRow
} from '../protocol'
import { clipBytes } from '../shared/text'
import { pageWindow } from '../shared/thread-window'

type ToolRow = Extract<ThreadRow, { kind: 'tool' }>

/** État opaque d'un fil : lignes dans l'ordre d'arrivée, index par id, événements déjà vus. */
export type ThreadState = {
  rows: ThreadRow[]
  indexById: Map<string, number>
  /** Id d'événement vers son `processed_at` à la première livraison, pour le dédoublonnage. */
  seen: Map<string, string | null>
  /** Appels d'outil en attente d'un accord, dans l'ordre. */
  pending: Set<string>
}

export function createThreadState(): ThreadState {
  return { rows: [], indexById: new Map(), seen: new Map(), pending: new Set() }
}

/** Concatène le texte des blocs `text` ; les images, documents et blocs masqués n'ont pas de texte. */
type TextLike = { type: string; text?: string }

function blocksText(blocks: readonly TextLike[] | undefined): string {
  if (!blocks) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined) parts.push(block.text)
  }
  return parts.join('\n')
}

function appendRow(state: ThreadState, row: ThreadRow): ThreadRow[] {
  state.indexById.set(row.id, state.rows.length)
  state.rows.push(row)
  return [row]
}

/** Remplace une ligne par une copie modifiée : les lignes déjà rendues ne sont jamais mutées. */
function replaceRow(state: ThreadState, row: ThreadRow): ThreadRow[] {
  const index = state.indexById.get(row.id)
  if (index === undefined) return []
  state.rows[index] = row
  return [row]
}

function toolRowOf(state: ThreadState, toolUseId: string): ToolRow | null {
  const index = state.indexById.get(toolUseId)
  if (index === undefined) return null
  const row = state.rows[index]
  return row.kind === 'tool' ? row : null
}

/** Confirmation ou résultat : dans les deux cas l'appel n'attend plus d'accord. */
function updateTool(state: ThreadState, toolUseId: string, change: Partial<ToolRow>): ThreadRow[] {
  const row = toolRowOf(state, toolUseId)
  if (!row) return []
  state.pending.delete(toolUseId)
  return replaceRow(state, { ...row, ...change, needsConfirmation: false })
}

function newToolRow(
  event: { id: string; name: string; input: { [key: string]: unknown }; processed_at: string },
  server: string | null,
  permission: string | undefined
): ToolRow {
  const awaiting = permission === 'ask'
  return {
    id: event.id,
    at: event.processed_at,
    kind: 'tool',
    name: event.name,
    server,
    input: clipBytes(JSON.stringify(event.input, null, 2), TOOL_IO_LIMIT_BYTES),
    result: null,
    state: awaiting ? 'awaiting_approval' : 'running',
    needsConfirmation: awaiting
  }
}

function toolResultChange(content: readonly TextLike[] | undefined, isError: boolean | null | undefined): Partial<ToolRow> {
  return { result: clipBytes(blocksText(content), TOOL_IO_LIMIT_BYTES), state: isError ? 'error' : 'done' }
}

function statusRow(id: string, at: string | null, text: string, tone: 'neutral' | 'warning' | 'danger'): ThreadRow {
  return { id, at, kind: 'status', text, tone }
}

/** Lignes produites par un événement : appelée une seule fois par id d'événement. */
function reduceEvent(state: ThreadState, event: BetaManagedAgentsSessionEvent): ThreadRow[] {
  switch (event.type) {
    case 'user.message':
    case 'agent.message': {
      const text: ClippedText = clipBytes(blocksText(event.content), MESSAGE_LIMIT_BYTES)
      const kind = event.type === 'user.message' ? 'user_message' : 'agent_message'
      return appendRow(state, { id: event.id, at: event.processed_at ?? null, kind, text })
    }
    case 'agent.tool_use':
    case 'agent.mcp_tool_use':
    case 'agent.custom_tool_use': {
      // `agent.custom_tool_use` n'a pas de `evaluated_permission` : il n'attend jamais d'accord.
      const permission = event.type === 'agent.custom_tool_use' ? undefined : event.evaluated_permission
      const server = event.type === 'agent.mcp_tool_use' ? event.mcp_server_name : null
      const row = newToolRow(event, server, permission)
      if (row.needsConfirmation) state.pending.add(row.id)
      return appendRow(state, row)
    }
    case 'user.tool_confirmation':
      return updateTool(state, event.tool_use_id, { state: event.result === 'allow' ? 'allowed' : 'denied' })
    case 'agent.tool_result':
      return updateTool(state, event.tool_use_id, toolResultChange(event.content, event.is_error))
    case 'agent.mcp_tool_result':
      return updateTool(state, event.mcp_tool_use_id, toolResultChange(event.content, event.is_error))
    case 'session.status_idle': {
      const at = event.processed_at
      switch (event.stop_reason.type) {
        case 'budget_reached':
          return appendRow(state, statusRow(event.id, at, 'Budget reached', 'danger'))
        case 'retries_exhausted':
          return appendRow(state, statusRow(event.id, at, 'Stopped after repeated errors', 'danger'))
        case 'refusal':
          return appendRow(state, statusRow(event.id, at, 'The model declined to continue', 'warning'))
        default:
          return []
      }
    }
    case 'session.error': {
      const text = clipBytes(`${event.error.type}: ${event.error.message}`, TOOL_IO_LIMIT_BYTES).text
      return appendRow(state, statusRow(event.id, event.processed_at, text, 'danger'))
    }
    case 'session.status_terminated':
      return appendRow(state, statusRow(event.id, event.processed_at, 'Session terminated', 'neutral'))
    case 'user.interrupt':
      return appendRow(state, statusRow(event.id, event.processed_at ?? null, 'Interrupted', 'neutral'))
    default:
      // `agent.thinking` (sans contenu dans le SDK 1.8.0), `span.*`, `session.status_running`,
      // `session.usage` et le reste : invisibles dans le fil.
      return []
  }
}

/**
 * Applique un événement et rend les lignes nouvelles ou modifiées (`[]` pour un doublon ou un
 * événement invisible). Un même id relivré avec un `processed_at` passé de null à une date ne met
 * la ligne à jour qu'une fois.
 */
export function applyEvent(state: ThreadState, event: BetaManagedAgentsSessionEvent): ThreadRow[] {
  const at = 'processed_at' in event ? (event.processed_at ?? null) : null
  if (state.seen.has(event.id)) {
    const firstAt = state.seen.get(event.id)
    if (firstAt !== null || at === null) return []
    state.seen.set(event.id, at)
    const index = state.indexById.get(event.id)
    return index === undefined ? [] : replaceRow(state, { ...state.rows[index], at })
  }
  const rows = reduceEvent(state, event)
  // Un événement invisible n'est pas retenu : il ne coûte aucune mémoire et n'a rien à dédoublonner.
  if (rows.length > 0 || isUpdateEvent(event)) state.seen.set(event.id, at)
  return rows
}

/** Confirmations et résultats : sans ligne propre, mais à ne jamais rejouer. */
function isUpdateEvent(event: BetaManagedAgentsSessionEvent): boolean {
  return (
    event.type === 'user.tool_confirmation' || event.type === 'agent.tool_result' || event.type === 'agent.mcp_tool_result'
  )
}

type Page = { rows: ThreadRow[]; hasEarlier: boolean }

function pageBefore(state: ThreadState, end: number | null, count: number, maxBytes: number): Page {
  const { visible, firstIndex } = pageWindow(state.rows, end, { maxRows: count, maxBytes })
  return { rows: visible, hasEarlier: firstIndex > 0 }
}

/** Les dernières lignes, jusqu'au premier plafond atteint (`count` lignes ou `maxBytes` octets). */
export function tail(state: ThreadState, count: number, maxBytes: number = THREAD_WINDOW_BYTES): Page {
  return pageBefore(state, null, count, maxBytes)
}

/** Les lignes qui précèdent `beforeId`, avec les mêmes plafonds que `tail` ; vide si l'id est inconnu. */
export function rowsBefore(state: ThreadState, beforeId: string, count: number, maxBytes: number = THREAD_WINDOW_BYTES): Page {
  const end = state.indexById.get(beforeId)
  if (end === undefined) return { rows: [], hasEarlier: false }
  return pageBefore(state, end, count, maxBytes)
}

/** Ids des appels d'outil qui attendent encore un `user.tool_confirmation`. */
export function pendingToolUseIds(state: ThreadState): string[] {
  return [...state.pending]
}
