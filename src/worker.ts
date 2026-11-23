// Worker du plugin : le seul côté qui a le réseau. Il détient la clé API et répond au panneau.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ApiResult, ResourceRef, SessionRow, ThreadRow, WorkspaceInfo } from './protocol'
import { createAgentAdapter, releaseArchivedDrafts } from './worker/agent-drafts'
import { agentFormOptions, prepareAgentForm } from './worker/agent-form'
import { attempt, createClientStore, describeError, failure, probeKey, workspaceInfo } from './worker/client'
import { createWriteHandlers } from './worker/config-writes'
import { createConfigHandlers } from './worker/configs'
import { DRAFTS_FOLDER, createDrafts, type Drafts } from './worker/drafts'
import { createEditorHost } from './worker/editor-host'
import { createMemoryAdapter, createMemoryRename, releaseDeletedDrafts } from './worker/memory-drafts'
import { createFilePicker, createMemoryUploads, runOsascript } from './worker/memory-uploads'
import { createPendingWrites } from './worker/pending-writes'
import { createSessionHandlers } from './worker/session-actions'
import { createPoller, sdkPollSource, thenSettleSessions } from './worker/session-poll'
import { createWatcher, sdkEventSource } from './worker/stream'
import { createWorkspaceHandlers } from './worker/workspace-handlers'
import { createWorkspaces } from './worker/workspaces'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  // Les workspaces associés : un index sans clé et une clé par secret. Le client suit la clé de l'actif.
  const workspaces = createWorkspaces({
    secrets: orca.secrets,
    probe: (key) => probeKey(key),
    newId: () => crypto.randomUUID(),
    log: (message) => orca.log(message)
  })
  const store = createClientStore(() => workspaces.activeKey())
  // L'ancienne clé unique devient « Default » avant tout le reste ; un échec se note et le worker démarre quand même.
  const migrated = workspaces.migrate().catch((error: unknown) => {
    orca.log(`workspace migration failed: ${describeError(error).message}`)
  })

  // Les écritures qui attendent une confirmation : un worker relancé repart d'un registre vide, et
  // le panneau reçoit alors `expired` (il relance l'écriture).
  const pendingWrites = createPendingWrites(() => Date.now())

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

  // Un tour de rattrapage à la demande (jamais attendu) : le `sessions.changed` qui en résulte rejoint le panneau.
  const refreshSessions = (): void => {
    poller.refresh().catch((error: unknown) => orca.log(`sessions refresh failed: ${describeError(error).message}`))
  }

  // Le suivi en direct d'une session : le worker pousse, le panneau reçoit par `panels.post`.
  const watcher = createWatcher(sdkEventSource(store), {
    thread: (payload) => orca.panels.post('session.thread', payload),
    state: (payload) => orca.panels.post('stream.state', payload),
    // `session.updated.status` et `badge` sont indicatifs : l'instantané du sondeur a 10 à 60 s de
    // retard, et `running` tient lieu de défaut tant que la session n'y figure pas. L'en-tête du
    // panneau doit lire la ligne de la session dans `sessions.changed` (tâche 7).
    usage: (sessionId, cost, budget) => {
      const known = poller.snapshot().find((row) => row.id === sessionId)
      orca.panels.post('session.updated', {
        sessionId,
        status: known?.status ?? 'running',
        badge: known?.badge ?? 'running',
        cost,
        budget
      })
      // Un événement d'usage prouve que la session bouge : on rattrape l'instantané tout de suite.
      refreshSessions()
    },
    // Le statut change sur le flux bien avant le prochain tour du sondeur (10 à 60 s) : on le rattrape.
    statusChanged: () => refreshSessions(),
    log: (message) => orca.log(message)
  })

  // Les erreurs autres qu'un 401 sont levées : on les rend en texte lisible pour le panneau.
  async function readableWorkspaceInfo(): Promise<WorkspaceInfo> {
    try {
      return await workspaceInfo(store, workspaces)
    } catch (error) {
      throw new Error(describeError(error).message)
    }
  }

  // Les workspaces : toute bascule arrête le suivi, vide les écritures en attente et relance le sondeur.
  const workspaceHandlers = createWorkspaceHandlers({
    workspaces,
    store,
    watcher,
    pendingWrites,
    poller,
    info: readableWorkspaceInfo,
    log: (message) => orca.log(message),
    ready: migrated
  })
  orca.panels.handle('workspace.info', workspaceHandlers.info)
  orca.panels.handle('workspaces.add', workspaceHandlers.add)
  orca.panels.handle('workspaces.rename', workspaceHandlers.rename)
  orca.panels.handle('workspaces.replaceKey', workspaceHandlers.replaceKey)
  orca.panels.handle('workspaces.remove', workspaceHandlers.remove)
  orca.panels.handle('workspaces.activate', workspaceHandlers.activate)

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
      poller
        .refresh({ shared: true })
        .catch((error: unknown) => orca.log(`sessions refresh failed: ${describeError(error).message}`))
      return { ok: true, value: snapshot }
    }
    try {
      return { ok: true, value: await poller.refresh({ shared: true }) }
    } catch (error) {
      return failure(error)
    }
  })

  // Seul un ping « visible » compte : la fraîcheur de 15 s du sondeur fait le reste quand le panneau se tait.
  // La réponse dit au panneau si ce worker est neuf (`bootId`) et quelle session il suit : un panneau qui
  // n'a pas été remonté après un redémarrage du worker rouvre ainsi le suivi de sa vue ouverte.
  const bootId = crypto.randomUUID()
  orca.panels.handle('sessions.visibility', ({ visible }) => {
    if (visible) {
      poller.visible(Date.now())
    }
    return { bootId, watching: watcher.watching() }
  })

  // Le détail reprend le classement `idle` du sondeur (accords en attente, budget atteint) pour la session lue.
  const sessions = createSessionHandlers(store, (sessionId) => {
    const row = poller.snapshot().find((candidate) => candidate.id === sessionId)
    return row?.status === 'idle' ? { badge: row.badge, pendingApprovals: row.pendingApprovals } : null
  })
  // Un envoi, un accord ou une interruption réussi change le statut de la session : on le relit sans attendre.
  const thenRefresh =
    <I, T>(handler: (input: I) => Promise<ApiResult<T>>) =>
    async (input: I): Promise<ApiResult<T>> => {
      const result = await handler(input)
      if (result.ok) refreshSessions()
      return result
    }
  orca.panels.handle('session.send', thenRefresh(sessions.send))
  orca.panels.handle('session.confirm', thenRefresh(sessions.confirm))
  orca.panels.handle('session.interrupt', thenRefresh(sessions.interrupt))
  orca.panels.handle('session.create', sessions.create)
  orca.panels.handle('session.raiseBudget', thenRefresh(sessions.raiseBudget))
  orca.panels.handle('session.detail', sessions.detail)
  orca.panels.handle('diagnostics.testSpend', sessions.testSpend)

  const configs = createConfigHandlers(store)
  orca.panels.handle('configs.list', configs.list)
  orca.panels.handle('configs.detail', configs.detail)
  orca.panels.handle('memory.read', configs.readMemory)
  orca.panels.handle('createForm.options', configs.formOptions)

  const writes = createWriteHandlers(store, (message) => orca.log(message))
  orca.panels.handle('environment.save', writes.saveEnvironment)
  orca.panels.handle('vault.save', writes.saveVault)
  orca.panels.handle('memoryStore.save', writes.saveMemoryStore)
  orca.panels.handle('credential.save', writes.saveCredential)
  // Archiver ou supprimer une session : le sondeur relit la liste avant la réponse (le panneau la relit juste après).
  const thenRefreshSessions = (handler: (ref: ResourceRef) => Promise<ApiResult<null>>) =>
    thenSettleSessions(handler, poller, (message) => orca.log(message))

  orca.panels.handle('write.commit', ({ token, force }) => pendingWrites.commit(token, force))

  // Les brouillons : un fichier par agent ou mémoire, édité dans l'éditeur d'Orca. Les adaptateurs
  // reçoivent `drafts` par une fonction : ils servent à le construire.
  const activeLocalId = async (): Promise<string | null> => (await workspaces.index()).activeLocalId
  const drafts: Drafts = createDrafts({
    folder: DRAFTS_FOLDER,
    host: createEditorHost(orca.host),
    adapters: {
      agent: createAgentAdapter(store, () => drafts, activeLocalId, (message) => orca.log(message)),
      memory: createMemoryAdapter(store, () => drafts, (message) => orca.log(message))
    },
    // Un brouillon appartient au workspace où il a été ouvert ; les entrées d'avant les workspaces reviennent à l'entrée migrée.
    workspace: {
      active: activeLocalId,
      legacy: async () => (await workspaces.index()).migratedLocalId,
      nameOf: (localId) => workspaces.nameOf(localId)
    },
    pending: pendingWrites,
    now: () => new Date(),
    log: (message) => orca.log(message)
  })
  // Le choix d'un fichier et l'envoi groupé de mémoires : le contenu des fichiers reste dans le worker.
  orca.panels.handle('file.pick', createFilePicker({ platform: process.platform, run: runOsascript }))
  orca.panels.handle('memory.stageUploads', createMemoryUploads(store, pendingWrites, (message) => orca.log(message)))
  orca.panels.handle('memory.rename', createMemoryRename(store, () => drafts, (message) => orca.log(message)))
  // Un agent archivé n'a plus de brouillon propre à garder : son fichier et son nom se libèrent.
  const archiveThenRelease = thenRefreshSessions(writes.archive)
  orca.panels.handle('resource.archive', async (ref) => {
    const result = await archiveThenRelease(ref)
    if (result.ok) {
      await releaseArchivedDrafts(ref, () => drafts, (message) => orca.log(message))
    }
    return result
  })
  // Une mémoire ou une banque supprimée n'a plus de brouillon propre à garder : son fichier et son nom se libèrent.
  const removeThenRelease = thenRefreshSessions(writes.remove)
  orca.panels.handle('resource.delete', async (ref) => {
    const result = await removeThenRelease(ref)
    if (result.ok) {
      await releaseDeletedDrafts(ref, () => drafts, (message) => orca.log(message))
    }
    return result
  })
  // Le formulaire d'agent : les modèles proposés, puis l'écriture mise en attente (confirmée par `write.commit`).
  orca.panels.handle('agent.formOptions', () => attempt(store, (client) => agentFormOptions(client, (message) => orca.log(message))))
  orca.panels.handle('agent.prepareForm', (input) => prepareAgentForm(store, pendingWrites, input))
  orca.panels.handle('drafts.status', drafts.status)
  orca.panels.handle('draft.open', drafts.open)
  orca.panels.handle('draft.discard', drafts.discard)
  orca.panels.handle('draft.state', drafts.state)
  orca.panels.handle('draft.prepare', drafts.prepare)
  orca.panels.handle('workspace.back', ({ workspaceId }) => drafts.back(workspaceId))

  // Le premier tour du sondeur attend la migration : sans elle, il lirait un index encore vide.
  await migrated
  poller.start()
  orca.log('agent-claude-managed worker ready')
}
