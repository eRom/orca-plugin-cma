// Worker du plugin : le seul côté qui a le réseau. Il détient la clé API et répond au panneau.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ApiResult, SessionRow, ThreadRow, WorkspaceInfo } from './protocol'
import { SECRET_NAME, attempt, createClientStore, describeError, failure, setKey, workspaceInfo } from './worker/client'
import { createSessionHandlers } from './worker/session-actions'
import { createPoller, sdkPollSource } from './worker/session-poll'
import { createWatcher, sdkEventSource } from './worker/stream'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const store = createClientStore(orca.secrets)

  // Le sondeur des sessions : alimente la liste du panneau (`sessions.changed`) et la barre d'état.
  const poller = createPoller({
    ...sdkPollSource(store),
    publish: (rows) => orca.panels.post('sessions.changed', { rows }),
    statusBar: (bar) => {
      orca.host
        .call('statusBar.update', { id: 'approvals', text: bar.text, tone: bar.tone, tooltip: bar.tooltip })
        // La barre d'état n'existe que dans l'app desktop : un refus se note, sans casser le sondage.
        .catch((error: unknown) => orca.log(`statusBar.update refused: ${describeError(error).message}`))
    },
    log: (message) => orca.log(message),
    now: () => Date.now(),
    schedule: (ms, fn) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    }
  })

  // Le suivi en direct d'une session : le worker pousse, le panneau reçoit par `panels.post`.
  const watcher = createWatcher(sdkEventSource(store), {
    thread: (payload) => orca.panels.post('session.thread', payload),
    state: (payload) => orca.panels.post('stream.state', payload),
    // Statut et badge viennent de l'instantané du sondeur ; `running` tant que la session n'y figure pas.
    usage: (sessionId, cost, budget) => {
      const known = poller.snapshot().find((row) => row.id === sessionId)
      orca.panels.post('session.updated', {
        sessionId,
        status: known?.status ?? 'running',
        badge: known?.badge ?? 'running',
        cost,
        budget
      })
    },
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

  orca.panels.handle('key.set', async ({ key }) => {
    watcher.stop()
    const result = await setKey(orca.secrets, store, key)
    // Une clé acceptée relance le sondage ; une clé refusée a été supprimée : plus rien à sonder.
    if (result.ok) {
      poller.start()
    } else {
      poller.stop()
    }
    return result
  })

  orca.panels.handle('key.clear', async () => {
    watcher.stop()
    poller.stop()
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

  // L'instantané part tout de suite, le rafraîchissement suit et arrive par `sessions.changed`.
  orca.panels.handle('sessions.list', async (): Promise<ApiResult<SessionRow[]>> => {
    const snapshot = poller.snapshot()
    if (snapshot.length > 0) {
      poller.refresh().catch((error: unknown) => orca.log(`sessions refresh failed: ${describeError(error).message}`))
      return { ok: true, value: snapshot }
    }
    try {
      return { ok: true, value: await poller.refresh() }
    } catch (error) {
      return failure(error)
    }
  })

  // Seul un ping « visible » compte : la fraîcheur de 15 s du sondeur fait le reste quand le panneau se tait.
  orca.panels.handle('sessions.visibility', ({ visible }) => {
    if (visible) {
      poller.visible(Date.now())
    }
    return null
  })

  const sessions = createSessionHandlers(store)
  orca.panels.handle('session.send', sessions.send)
  orca.panels.handle('session.confirm', sessions.confirm)
  orca.panels.handle('session.interrupt', sessions.interrupt)
  orca.panels.handle('session.create', sessions.create)
  orca.panels.handle('session.raiseBudget', sessions.raiseBudget)
  orca.panels.handle('session.detail', sessions.detail)
  orca.panels.handle('diagnostics.testSpend', sessions.testSpend)

  poller.start()
  orca.log('agent-claude-managed worker ready')
}
