// Worker du plugin : le seul côté qui a le réseau. Il détient la clé API et répond au panneau.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ApiResult, DraftsProject, DraftsStatus, ResourceRef, SessionRow, ThreadRow, WorkspaceInfo } from './protocol'
import { createAgentAdapter, releaseArchivedDrafts } from './worker/agent-drafts'
import { agentFormOptions, prepareAgentForm } from './worker/agent-form'
import { attempt, createClientStore, describeError, failure, probeKey, workspaceInfo } from './worker/client'
import { createWriteHandlers } from './worker/config-writes'
import { createConfigHandlers } from './worker/configs'
import { createDrafts, type Drafts } from './worker/drafts'
import { LEGACY_DRAFTS_FOLDER, createDraftsLocation, guardDrafts } from './worker/drafts-location'
import { createEditorHost } from './worker/editor-host'
import { createMemoryAdapter, createMemoryRename, releaseDeletedDrafts } from './worker/memory-drafts'
import { createFilePicker, createMemoryUploads, runOsascript } from './worker/memory-uploads'
import { createPendingWrites } from './worker/pending-writes'
import { createResourceHandlers } from './worker/resources'
import { createSessionHandlers } from './worker/session-actions'
import { createPoller, sdkPollSource, thenSettleSessions } from './worker/session-poll'
import { createWatcher, sdkEventSource } from './worker/stream'
import { createWorkspaceHandlers } from './worker/workspace-handlers'
import { createWorkspaces } from './worker/workspaces'

let stopBackground: () => void = () => {}

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

  // Les erreurs autres qu'un 401 sont levées : on les rend en texte lisible ; le gestionnaire les journalise et répond d'après l'index.
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
    announce: (info) => orca.panels.post('workspace.changed', info),
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
  // Le dossier vit dans un projet de la barre latérale d'Orca, choisi par Romain : tant qu'aucun n'est retenu,
  // `drafts` est null et les requêtes `draft.*` se refusent.
  const editorHost = createEditorHost(orca.host)
  const location = createDraftsLocation({
    projects: editorHost.projects,
    store: orca.storage,
    legacyFolder: LEGACY_DRAFTS_FOLDER,
    log: (message) => orca.log(message)
  })
  let drafts: Drafts | null = null
  // Le dossier sur lequel `drafts` est construit : un autre dossier à la relecture force la reconstruction.
  let draftsFolder: string | null = null
  // Les adaptateurs ne servent qu'à travers `draft.*`, donc seulement une fois `drafts` construit.
  const liveDrafts = (): Drafts => {
    if (drafts === null) throw new Error('The drafts folder is not chosen.')
    return drafts
  }
  const buildDrafts = (folder: string): Drafts => createDrafts({
    folder,
    host: editorHost,
    adapters: {
      agent: createAgentAdapter(store, liveDrafts, activeLocalId, (message) => orca.log(message)),
      memory: createMemoryAdapter(store, liveDrafts, (message) => orca.log(message))
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
  const adopt = (folder: string | null): Drafts | null => {
    if (folder === null) {
      drafts = null
      draftsFolder = null
    } else if (folder !== draftsFolder || drafts === null) {
      drafts = buildDrafts(folder)
      draftsFolder = folder
    }
    return drafts
  }
  // Le dossier se relit à chaque requête : un projet masqué ou retiré dans Orca retire les brouillons, un projet
  // revenu les rend, et une lecture refusée au démarrage ne laisse pas le plugin sans brouillons pour toujours.
  // Une lecture refusée n'efface rien : elle se journalise et la requête en cours se refuse, la suivante relit.
  const currentDrafts = async (): Promise<Drafts | null> => {
    try {
      return adopt(await location.folder())
    } catch (error) {
      orca.log(`drafts folder not resolved: ${describeError(error).message}`)
      return null
    }
  }
  await currentDrafts()
  // Le choix d'un fichier et l'envoi groupé de mémoires : le contenu des fichiers reste dans le worker.
  orca.panels.handle('file.pick', createFilePicker({ platform: process.platform, run: runOsascript }))
  // Les skills et les fichiers de l'espace : listes, envois (le contenu est lu ici) et suppressions.
  const resources = createResourceHandlers(store)
  orca.panels.handle(
    'skills.pickFolder',
    createFilePicker(
      { platform: process.platform, run: runOsascript },
      { kind: 'folder', prompt: 'Choose a skill folder (it must contain SKILL.md)' }
    )
  )
  orca.panels.handle(
    'files.pickFile',
    createFilePicker({ platform: process.platform, run: runOsascript }, { kind: 'file', prompt: 'Choose a file to upload' })
  )
  orca.panels.handle('skills.list', resources.listSkills)
  orca.panels.handle('skills.listAnthropic', resources.listAnthropicSkills)
  orca.panels.handle('skills.upload', resources.uploadSkill)
  orca.panels.handle('skills.uploadVersion', resources.uploadSkillVersion)
  orca.panels.handle('skills.delete', resources.deleteSkill)
  orca.panels.handle('files.list', resources.listFiles)
  orca.panels.handle('files.upload', resources.uploadFile)
  orca.panels.handle('files.delete', resources.deleteFile)
  orca.panels.handle('memory.stageUploads', createMemoryUploads(store, pendingWrites, (message) => orca.log(message)))
  orca.panels.handle('memory.rename', async (input) => {
    const current = await currentDrafts()
    return createMemoryRename(store, () => current, (message) => orca.log(message))(input)
  })
  // Un agent archivé n'a plus de brouillon propre à garder : son fichier et son nom se libèrent.
  const archiveThenRelease = thenRefreshSessions(writes.archive)
  orca.panels.handle('resource.archive', async (ref) => {
    const result = await archiveThenRelease(ref)
    const current = result.ok ? await currentDrafts() : null
    if (current !== null) {
      await releaseArchivedDrafts(ref, () => current, (message) => orca.log(message))
    }
    return result
  })
  // Une mémoire ou une banque supprimée n'a plus de brouillon propre à garder : son fichier et son nom se libèrent.
  const removeThenRelease = thenRefreshSessions(writes.remove)
  orca.panels.handle('resource.delete', async (ref) => {
    const result = await removeThenRelease(ref)
    const current = result.ok ? await currentDrafts() : null
    if (current !== null) {
      await releaseDeletedDrafts(ref, () => current, (message) => orca.log(message))
    }
    return result
  })
  // Le formulaire d'agent : les modèles proposés, puis l'écriture mise en attente (confirmée par `write.commit`).
  orca.panels.handle('agent.formOptions', () => attempt(store, (client) => agentFormOptions(client, (message) => orca.log(message))))
  orca.panels.handle('agent.prepareForm', (input) => prepareAgentForm(store, pendingWrites, input))
  orca.panels.handle('drafts.status', async () => {
    const current = await currentDrafts()
    return current === null ? { folder: '', ready: false } : current.status()
  })
  // Les projets où loger les brouillons ; le choix déplace les brouillons, puis `drafts` est reconstruit sur le nouveau dossier.
  orca.panels.handle('drafts.projects', async (): Promise<ApiResult<DraftsProject[]>> => {
    try {
      return { ok: true, value: await location.projects() }
    } catch (error) {
      return failure(error)
    }
  })
  orca.panels.handle('drafts.choose', async ({ projectId }): Promise<ApiResult<DraftsStatus>> => {
    const chosen = await location.choose(projectId)
    if (!chosen.ok) return chosen
    // Rechoisir le projet courant ne déplace rien : on reconstruit sur le dossier, même inchangé.
    drafts = buildDrafts(chosen.value.folder)
    draftsFolder = chosen.value.folder
    return { ok: true, value: await drafts.status() }
  })
  orca.panels.handle('draft.open', async (ref) => guardDrafts(await currentDrafts(), (current) => current.open(ref)))
  orca.panels.handle('draft.discard', async (ref) => guardDrafts(await currentDrafts(), (current) => current.discard(ref)))
  orca.panels.handle('draft.state', async (ref) => guardDrafts(await currentDrafts(), (current) => current.state(ref)))
  orca.panels.handle('draft.prepare', async (ref) => guardDrafts(await currentDrafts(), (current) => current.prepare(ref)))
  orca.panels.handle('workspace.back', async ({ workspaceId }) => {
    const current = await currentDrafts()
    return current === null ? { ok: true as const, value: null } : current.back(workspaceId)
  })

  // Le premier tour du sondeur attend la migration : sans elle, il lirait un index encore vide.
  await migrated
  poller.start()
  stopBackground = () => {
    poller.stop()
    watcher.stop()
  }
  orca.log('agent-claude-managed worker ready')
}

/** Arrête ce que le worker fait en tâche de fond (sondeur, suivi en direct) : Orca l'appelle au déchargement du plugin. */
export function deactivate(): void {
  stopBackground()
  stopBackground = () => {}
}
