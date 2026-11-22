// `orca plugin check` dessine le panneau une fois par scénario ; le worker y est remplacé par des
// réponses figées, donc aucun appel réseau et aucune clé.
import { defineCheck } from 'orca/testing'
import type { CreateFormOptions, SessionDetail, SessionRow, StreamState, ThreadRow } from './protocol'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_check',
  organizationName: 'Check Org'
}

const session = {
  agentId: 'agent_check',
  agentName: 'Writer',
  budget: null,
  cost: { minor: '125', currency: 'USD' },
  pendingApprovals: 0
}

export default defineCheck({
  'no key': {
    requests: { 'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null } }
  },
  'key saved': {
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': null,
      'sessions.list': { ok: true, value: [] }
    }
  },
  'key saved with sessions': {
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': null,
      'sessions.list': {
        ok: true,
        value: [
          { ...session, id: 'sesn_idle', title: 'Quiet one', status: 'idle', badge: 'idle', updatedAt: '2026-11-22T12:00:00Z' },
          {
            ...session,
            id: 'sesn_wait',
            title: null,
            status: 'idle',
            badge: 'needs_approval',
            pendingApprovals: 2,
            updatedAt: '2026-11-22T09:00:00Z'
          },
          { ...session, id: 'sesn_run', title: 'Busy one', status: 'running', badge: 'running', updatedAt: '2026-11-22T11:00:00Z' }
        ]
      }
    }
  },
  'rejected key': {
    requests: { 'workspace.info': { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null } }
  },
  'new session form': newSessionScenario(),
  'session with approval': sessionScenario({
    row: sessionRow({ badge: 'needs_approval', pendingApprovals: 1, status: 'idle' }),
    rows: [
      text('u1', 'user_message', 'List the 3 most recent commits of **anthropics/anthropic-sdk-typescript**.'),
      text(
        'a1',
        'agent_message',
        "I'll look at the repository with the GitHub tools.\n\n1. Fetch the latest commits\n2. Summarise each one\n\nThen I'll open an issue if something looks off."
      ),
      tool('t1', 'list_commits', 'running', {
        input: '{\n  "owner": "anthropics",\n  "repo": "anthropic-sdk-typescript",\n  "per_page": 3\n}',
        result: '[{"sha":"f3a9c1e","message":"fix: retry on 529"},{"sha":"0b7d2aa","message":"chore: bump deps"}]',
        state: 'done'
      }),
      tool('t2', 'create_issue', 'awaiting_approval', {
        input: '{\n  "owner": "anthropics",\n  "repo": "anthropic-sdk-typescript",\n  "title": "Retry docs are out of date"\n}',
        needsConfirmation: true
      })
    ]
  }),
  'huge thread': sessionScenario({
    row: sessionRow({ badge: 'idle', status: 'idle' }),
    rows: Array.from({ length: 50 }, (_, index) => text(`h${index}`, index % 2 === 0 ? 'user_message' : 'agent_message', hugeText(index)))
  }),
  'terminated session': sessionScenario({
    row: sessionRow({ badge: 'terminated', status: 'terminated' }),
    rows: [
      text('u1', 'user_message', 'Triage INC-42'),
      text('a1', 'agent_message', 'Done. The root cause was a stale cache entry.'),
      { id: 's1', at: null, kind: 'status', text: 'Session terminated.', tone: 'neutral' }
    ]
  }),
  'budget reached': sessionScenario({
    row: sessionRow({ badge: 'budget_reached', status: 'idle', cost: { minor: '50', currency: 'USD' } }),
    rows: [
      text('u1', 'user_message', 'Refactor the whole repo.'),
      text('a1', 'agent_message', 'Starting with the parser module.'),
      { id: 's1', at: null, kind: 'status', text: 'Session stopped: budget reached.', tone: 'warning' }
    ]
  })
})

/** Ligne de session : l'état du sondeur du worker, dont le panneau tire son badge. */
function sessionRow(over: Partial<SessionRow>): SessionRow {
  return {
    id: 'sesn_check',
    title: 'Triage the SDK repo',
    agentId: 'agent_check',
    agentName: 'Writer',
    status: 'idle',
    badge: 'idle',
    cost: { minor: '37', currency: 'USD' },
    budget: { minor: '50', currency: 'USD' },
    updatedAt: '2026-11-22T12:00:00Z',
    pendingApprovals: 0,
    ...over
  }
}

function text(id: string, kind: 'user_message' | 'agent_message', body: string): ThreadRow {
  return { id, at: null, kind, text: { text: body, truncated: false } }
}

function tool(
  id: string,
  name: string,
  state: 'running' | 'awaiting_approval',
  over: { input: string; result?: string; state?: 'done'; needsConfirmation?: boolean }
): ThreadRow {
  return {
    id,
    at: null,
    kind: 'tool',
    name,
    server: 'github',
    input: { text: over.input, truncated: false },
    result: over.result ? { text: over.result, truncated: false } : null,
    state: over.state ?? state,
    needsConfirmation: over.needsConfirmation ?? false
  }
}

/** Un message de 16 000 octets exactement (la limite d'un message côté worker), en paragraphes lisibles. */
function hugeText(index: number): string {
  const paragraph = `Paragraph of message ${index}: the quick brown fox jumps over the lazy dog, again and again.\n\n`
  let body = ''
  while (body.length + paragraph.length <= 16_000) body += paragraph
  return body.padEnd(16_000, '.')
}

/** Le formulaire de création, ouvert et vierge (rien n'y est persisté ; le check ne sait pas cliquer). */
function newSessionScenario() {
  const options: CreateFormOptions = {
    agents: [
      { kind: 'agent', id: 'agent_check', name: 'Writer', summary: 'v4 · claude-haiku-5-5' },
      { kind: 'agent', id: 'agent_other', name: 'Reviewer', summary: 'v1 · claude-sonnet-5' }
    ],
    environments: [{ kind: 'environment', id: 'env_check', name: 'Sandbox', summary: 'cloud' }],
    vaults: [{ kind: 'vault', id: 'vlt_check', name: 'GitHub', summary: '1 credential' }],
    memoryStores: [{ kind: 'memory_store', id: 'memstore_check', name: 'Notes', summary: '4 memories' }]
  }
  return {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'newSession' }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': null,
      'sessions.list': { ok: true as const, value: [] },
      'createForm.options': { ok: true as const, value: options }
    }
  }
}

function sessionScenario(input: { row: SessionRow; rows: ThreadRow[] }) {
  const stream: StreamState = { sessionId: input.row.id, phase: 'open', since: 0, reconnects: 0, error: null }
  const detail: SessionDetail = {
    ...input.row,
    agentVersion: 4,
    environmentId: 'env_check',
    environmentName: 'Sandbox',
    vaultIds: ['vlt_check'],
    resources: [],
    createdAt: '2026-11-22T09:00:00Z'
  }
  return {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'session', sessionId: input.row.id }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': null,
      'sessions.list': { ok: true as const, value: [input.row] },
      'session.watch': { ok: true as const, value: { rows: input.rows, hasEarlier: false, stream } },
      'session.detail': { ok: true as const, value: detail },
      'session.leave': null
    }
  }
}
