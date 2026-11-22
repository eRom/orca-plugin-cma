import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentToolResultEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsSpanModelRequestStartEvent,
  BetaManagedAgentsUserMessageEvent,
  BetaManagedAgentsUserToolConfirmationEvent
} from '@anthropic-ai/sdk/resources/beta/sessions/events'
import { expect, test } from 'bun:test'
import { THREAD_WINDOW_BYTES, TOOL_IO_LIMIT_BYTES, type ThreadRow } from '../protocol'
import { rowBytes } from '../shared/thread-window'
import { applyEvent, createThreadState, pendingToolUseIds, rowsBefore, tail } from './thread'

const T = '2026-11-22T10:00:00Z'

// Fabriques d'événements typées avec le SDK : une dérive de forme casse le typecheck.
function userMessage(id: string, text: string, at: string | null): BetaManagedAgentsUserMessageEvent {
  return { id, type: 'user.message', content: [{ type: 'text', text }], processed_at: at }
}

function agentMessage(id: string, text: string): BetaManagedAgentsAgentMessageEvent {
  return { id, type: 'agent.message', content: [{ type: 'text', text }], processed_at: T }
}

function toolUse(id: string, permission?: 'ask' | 'allow'): BetaManagedAgentsAgentToolUseEvent {
  return { id, type: 'agent.tool_use', name: 'bash', input: { command: 'ls' }, processed_at: T, evaluated_permission: permission }
}

function mcpToolUse(id: string, server: string, permission?: 'ask' | 'allow'): BetaManagedAgentsAgentMCPToolUseEvent {
  return {
    id,
    type: 'agent.mcp_tool_use',
    name: 'create_issue',
    mcp_server_name: server,
    input: { title: 'x' },
    processed_at: T,
    evaluated_permission: permission
  }
}

function customToolUse(id: string): BetaManagedAgentsAgentCustomToolUseEvent {
  return { id, type: 'agent.custom_tool_use', name: 'lookup', input: { q: 1 }, processed_at: T }
}

function confirmation(id: string, toolUseId: string, result: 'allow' | 'deny'): BetaManagedAgentsUserToolConfirmationEvent {
  return { id, type: 'user.tool_confirmation', tool_use_id: toolUseId, result, processed_at: T }
}

function toolResult(id: string, toolUseId: string, text: string, isError = false): BetaManagedAgentsAgentToolResultEvent {
  return { id, type: 'agent.tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }], is_error: isError, processed_at: T }
}

function mcpToolResult(id: string, toolUseId: string, text: string): BetaManagedAgentsAgentMCPToolResultEvent {
  return { id, type: 'agent.mcp_tool_result', mcp_tool_use_id: toolUseId, content: [{ type: 'text', text }], processed_at: T }
}

function idle(id: string, reason: 'end_turn' | 'budget_reached' | 'retries_exhausted' | 'refusal'): BetaManagedAgentsSessionStatusIdleEvent {
  return { id, type: 'session.status_idle', stop_reason: { type: reason }, stop_details: null, processed_at: T }
}

function sessionError(id: string): BetaManagedAgentsSessionErrorEvent {
  return {
    id,
    type: 'session.error',
    error: { type: 'unknown_error', message: 'boom', retry_status: { type: 'terminal' } },
    processed_at: T
  }
}

function spanStart(id: string): BetaManagedAgentsSpanModelRequestStartEvent {
  return { id, type: 'span.model_request_start', processed_at: T }
}

type ToolRow = Extract<ThreadRow, { kind: 'tool' }>

function asTool(row: ThreadRow | undefined): ToolRow {
  if (!row || row.kind !== 'tool') throw new Error('expected a tool row')
  return row
}

test('dedupes a user message processed twice', () => {
  const state = createThreadState()
  const first = applyEvent(state, userMessage('evt_1', 'hello', null))
  const second = applyEvent(state, userMessage('evt_1', 'hello', T))
  const third = applyEvent(state, userMessage('evt_1', 'hello', T))
  expect([first.length, second.length, third.length]).toEqual([1, 1, 0])
  expect(first[0].at).toBe(null)
  expect(tail(state, 10).rows[0].at).toBe(T)
})

test('walks an MCP approval to done', () => {
  const state = createThreadState()
  const call = asTool(applyEvent(state, mcpToolUse('sevt_1', 'github', 'ask'))[0])
  const allowed = asTool(applyEvent(state, confirmation('evt_2', 'sevt_1', 'allow'))[0])
  const done = asTool(applyEvent(state, mcpToolResult('sevt_3', 'sevt_1', 'issue created'))[0])
  expect([call.state, allowed.state, done.state]).toEqual(['awaiting_approval', 'allowed', 'done'])
  expect(call.server).toBe('github')
  expect(call.needsConfirmation).toBe(true)
  expect(allowed.needsConfirmation).toBe(false)
  expect(allowed.id).toBe(call.id)
  expect(done.id).toBe(call.id)
  expect(done.result?.text).toBe('issue created')
  expect(pendingToolUseIds(state)).toEqual([])
  expect(tail(state, 10).rows.length).toBe(1)
})

test('marks a denied call', () => {
  const state = createThreadState()
  applyEvent(state, toolUse('sevt_1', 'ask'))
  const denied = asTool(applyEvent(state, confirmation('evt_2', 'sevt_1', 'deny'))[0])
  expect(denied.state).toBe('denied')
  expect(denied.needsConfirmation).toBe(false)
})

test('tracks two pending approvals', () => {
  const state = createThreadState()
  applyEvent(state, toolUse('sevt_1', 'ask'))
  applyEvent(state, toolUse('sevt_2', 'ask'))
  expect(pendingToolUseIds(state)).toEqual(['sevt_1', 'sevt_2'])
  applyEvent(state, confirmation('evt_3', 'sevt_1', 'allow'))
  expect(pendingToolUseIds(state)).toEqual(['sevt_2'])
})

test('clips a 200 KB tool result', () => {
  const state = createThreadState()
  applyEvent(state, toolUse('sevt_1', 'allow'))
  const row = asTool(applyEvent(state, toolResult('sevt_2', 'sevt_1', 'x'.repeat(200_000)))[0])
  expect(row.result?.truncated).toBe(true)
  expect(new TextEncoder().encode(row.result?.text ?? '').length <= TOOL_IO_LIMIT_BYTES).toBe(true)
})

test('adds status rows only for notable stops', () => {
  const state = createThreadState()
  const budget = applyEvent(state, idle('evt_1', 'budget_reached'))
  expect(budget).toEqual([{ id: 'evt_1', at: T, kind: 'status', text: 'Budget reached', tone: 'danger' }])
  expect(applyEvent(state, idle('evt_2', 'end_turn'))).toEqual([])
  expect(applyEvent(state, spanStart('evt_3'))).toEqual([])
})

test('maps the other notable stops to status rows', () => {
  const state = createThreadState()
  const retries = applyEvent(state, idle('evt_1', 'retries_exhausted'))[0]
  const refusal = applyEvent(state, idle('evt_2', 'refusal'))[0]
  const error = applyEvent(state, sessionError('evt_3'))[0]
  expect([retries.kind, retries.kind === 'status' && retries.text, retries.kind === 'status' && retries.tone]).toEqual([
    'status',
    'Stopped after repeated errors',
    'danger'
  ])
  expect([refusal.kind === 'status' && refusal.text, refusal.kind === 'status' && refusal.tone]).toEqual([
    'The model declined to continue',
    'warning'
  ])
  expect([error.kind === 'status' && error.text, error.kind === 'status' && error.tone]).toEqual(['unknown_error: boom', 'danger'])
})

test('keeps a custom tool call running and ignores an orphan result', () => {
  const state = createThreadState()
  const call = asTool(applyEvent(state, customToolUse('sevt_1'))[0])
  expect([call.state, call.needsConfirmation, call.server]).toEqual(['running', false, null])
  expect(applyEvent(state, toolResult('sevt_9', 'sevt_unknown', 'lost'))).toEqual([])
  const failed = asTool(applyEvent(state, toolResult('sevt_2', 'sevt_1', 'nope', true))[0])
  expect(failed.state).toBe('error')
})

test('does not replay a duplicated confirmation over a finished call', () => {
  const state = createThreadState()
  applyEvent(state, toolUse('sevt_1', 'ask'))
  applyEvent(state, confirmation('evt_2', 'sevt_1', 'allow'))
  applyEvent(state, toolResult('sevt_3', 'sevt_1', 'ok'))
  expect(applyEvent(state, confirmation('evt_2', 'sevt_1', 'allow'))).toEqual([])
  expect(asTool(tail(state, 10).rows[0]).state).toBe('done')
})

test('pages history', () => {
  const state = createThreadState()
  for (let index = 0; index < 250; index++) applyEvent(state, agentMessage(`evt_${index}`, `m${index}`))
  const latest = tail(state, 100)
  expect(latest.rows.length).toBe(100)
  expect(latest.rows[0].id).toBe('evt_150')
  expect(latest.rows[99].id).toBe('evt_249')
  expect(latest.hasEarlier).toBe(true)
  const middle = rowsBefore(state, latest.rows[0].id, 100)
  expect(middle.rows.length).toBe(100)
  expect(middle.rows[0].id).toBe('evt_50')
  expect(middle.rows[99].id).toBe('evt_149')
  expect(middle.hasEarlier).toBe(true)
  const oldest = rowsBefore(state, middle.rows[0].id, 100)
  expect(oldest.rows.length).toBe(50)
  expect(oldest.rows[0].id).toBe('evt_0')
  expect(oldest.hasEarlier).toBe(false)
})

test('caps a page by bytes', () => {
  const state = createThreadState()
  for (let index = 0; index < 100; index++) applyEvent(state, agentMessage(`evt_${index}`, 'a'.repeat(16_000)))
  const page = tail(state, 100)
  const total = page.rows.reduce((sum, row) => sum + rowBytes(row), 0)
  expect(total <= THREAD_WINDOW_BYTES).toBe(true)
  expect(page.rows.length < 100).toBe(true)
  expect(page.hasEarlier).toBe(true)
  expect(page.rows[page.rows.length - 1].id).toBe('evt_99')
})

test('keeps at least one row when a single row exceeds the byte cap', () => {
  const state = createThreadState()
  applyEvent(state, agentMessage('evt_1', 'a'.repeat(5_000)))
  const page = tail(state, 10, 100)
  expect(page.rows.length).toBe(1)
  expect(page.hasEarlier).toBe(false)
})
