// `orca plugin check` dessine le panneau une fois par scénario ; le worker y est remplacé par des
// réponses figées, donc aucun appel réseau et aucune clé.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  'no key': {
    requests: { 'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null } }
  },
  'key saved': {
    requests: {
      'workspace.info': {
        hasKey: true,
        keyRejected: false,
        workspaceId: 'wrkspc_check',
        organizationName: 'Check Org'
      }
    }
  },
  'rejected key': {
    requests: { 'workspace.info': { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null } }
  }
})
