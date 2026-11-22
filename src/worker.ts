// Worker du plugin : le seul côté qui a le réseau. Il détient la clé API et répond au panneau.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ApiResult, ThreadRow, WorkspaceInfo } from './protocol'
import { SECRET_NAME, attempt, createClientStore, describeError, setKey, workspaceInfo } from './worker/client'
import { createSessionHandlers } from './worker/session-actions'
import { createWatcher, sdkEventSource } from './worker/stream'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const store = createClientStore(orca.secrets)

  // Le suivi en direct d'une session : le worker pousse, le panneau reçoit par `panels.post`.
  const watcher = createWatcher(sdkEventSource(store), {
    thread: (payload) => orca.panels.post('session.thread', payload),
    state: (payload) => orca.panels.post('stream.state', payload),
    // Pas encore d'instantané de session (le sondeur arrive plus tard) : `running` par défaut.
    usage: (sessionId, cost, budget) =>
      orca.panels.post('session.updated', { sessionId, status: 'running', badge: 'running', cost, budget }),
    log: (message) => orca.log(message)
  })

  // Les erreurs autres qu'un 401 sont levées : on les rend en texte lisible pour le panneau.
  async function readableWorkspaceInfo(): Promise<WorkspaceInfo> {
    try {
      return await workspaceInfo(store)
    } catch (error) {
      throw new Error(describeError(error).message)
    }
  }

  orca.panels.handle('workspace.info', readableWorkspaceInfo)

  orca.panels.handle('key.set', ({ key }) => {
    watcher.stop()
    return setKey(orca.secrets, store, key)
  })

  orca.panels.handle('key.clear', async () => {
    watcher.stop()
    await orca.secrets.delete(SECRET_NAME)
    store.reset()
    return { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null }
  })

  orca.panels.handle('session.watch', ({ sessionId }) => attempt(store, async () => watcher.watch(sessionId)))

  orca.panels.handle('session.leave', ({ sessionId }) => {
    watcher.leave(sessionId)
    return null
  })

  orca.panels.handle('session.loadEarlier', ({ sessionId, beforeId }): ApiResult<{ rows: ThreadRow[]; hasEarlier: boolean }> => {
    const page = watcher.loadEarlier(sessionId, beforeId)
    return page
      ? { ok: true, value: page }
      : { ok: false, code: 'other', error: 'This session is not open.' }
  })

  const sessions = createSessionHandlers(store)
  orca.panels.handle('session.send', sessions.send)
  orca.panels.handle('session.confirm', sessions.confirm)
  orca.panels.handle('session.interrupt', sessions.interrupt)
  orca.panels.handle('session.create', sessions.create)
  orca.panels.handle('session.raiseBudget', sessions.raiseBudget)
  orca.panels.handle('session.detail', sessions.detail)
  orca.panels.handle('diagnostics.testSpend', sessions.testSpend)

  orca.log('agent-claude-managed worker ready')
}
