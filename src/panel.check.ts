// `orca plugin check` dessine le panneau une fois par scénario ; le worker y est remplacé par des
// réponses figées, donc aucun appel réseau et aucune clé.
import { defineCheck } from 'orca/testing'
import type { EventRow, StreamState } from './protocol'

const SESSION_ID = 'sesn_check'
const NOW = Date.UTC(2026, 10, 22, 6, 0, 0)
const STREAM: StreamState = { sessionId: SESSION_ID, phase: 'open', since: NOW, reconnects: 0, error: null }

function row(id: string, type: string, text: string, extra: Partial<EventRow> = {}): EventRow {
  return {
    id,
    type,
    at: new Date(NOW).toISOString(),
    text,
    awaitsApproval: false,
    answers: null,
    ...extra
  }
}

const ROWS: EventRow[] = [
  row('sevt_1', 'user.message', 'Triage the checkout error.'),
  row('sevt_2', 'session.status_running', ''),
  row('sevt_3', 'agent.message', 'Looking at the **stack trace** now.'),
  row('sevt_4', 'agent.tool_use', 'bash {"command":"git log --since=72h"}', { awaitsApproval: true }),
  row('sevt_5', 'session.status_idle', 'requires_action')
]

const READY = {
  'probe.status': { hasKey: true, workerStartedAt: NOW, stream: null },
  'agents.list': {
    ok: true as const,
    value: [{ id: 'agent_check', name: 'Support triager', model: 'claude-opus-5-5', version: 3, description: null }]
  },
  'sessions.list': {
    ok: true as const,
    value: [
      {
        id: SESSION_ID,
        title: 'test-001',
        status: 'idle' as const,
        agentName: 'Support triager',
        createdAt: new Date(NOW).toISOString()
      }
    ]
  }
}

export default defineCheck({
  'no key': { requests: { 'probe.status': { hasKey: false, workerStartedAt: NOW, stream: null } } },
  'key saved': { requests: READY },
  'following a session': {
    requests: {
      ...READY,
      'probe.status': { hasKey: true, workerStartedAt: NOW, stream: STREAM },
      'session.watch': { ok: true as const, value: { rows: ROWS, stream: STREAM } }
    }
  },
  'rejected key': {
    requests: {
      ...READY,
      'agents.list': { ok: false as const, error: 'The API key was rejected (401).' },
      'sessions.list': { ok: false as const, error: 'The API key was rejected (401).' }
    }
  }
})
