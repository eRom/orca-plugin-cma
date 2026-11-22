// `orca plugin check` dessine le panneau une fois par scénario ; le worker y est remplacé par des
// réponses figées, donc aucun appel réseau et aucune clé.
import { defineCheck } from 'orca/testing'

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
  }
})
