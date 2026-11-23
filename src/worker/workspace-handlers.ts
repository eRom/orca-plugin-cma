// Les gestionnaires `workspaces.*` du worker et les effets d'un changement d'actif. Extraits de
// `worker.ts` pour tenir sous `bun test` : la bascule doit arrêter le suivi et vider les écritures en attente.
import type { ApiResult, WorkspaceInfo } from '../protocol'
import type { Workspaces } from './workspaces'

export type WorkspaceHandlerDeps = {
  workspaces: Workspaces
  store: { reset(): void }
  watcher: { stop(): void }
  pendingWrites: { clear(): void }
  poller: { start(): void; stop(): void }
  /** L'état à rendre au panneau après un changement (`workspaceInfo` du magasin). */
  info: () => Promise<WorkspaceInfo>
  /** Dit à tous les panneaux que l'actif a changé (`workspace.changed`) : un panneau qui n'a pas fait la demande l'apprend ainsi. */
  announce: (info: WorkspaceInfo) => void
  log: (message: string) => void
  /** Résolue quand la migration de l'ancienne clé est faite : aucun gestionnaire ne lit l'index avant. */
  ready: Promise<void>
}

export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps) {
  const { workspaces, store, watcher, pendingWrites, poller } = deps

  /**
   * Le workspace actif a changé : l'ancien client, le suivi en direct et les écritures préparées sous lui
   * ne valent plus (un Confirm tardif se dit `expired`). Le sondeur repart sur le nouvel actif, ou s'arrête
   * quand il n'y en a plus.
   */
  async function switchWorkspace(): Promise<void> {
    const { activeLocalId } = await workspaces.index()
    store.reset()
    watcher.stop()
    pendingWrites.clear()
    if (activeLocalId === null) {
      poller.stop()
    } else {
      poller.start()
    }
  }

  /**
   * L'état à rendre au panneau, après une mutation réussie comme à sa lecture. Si la lecture échoue (réseau, 429,
   * 5xx), on rend un état dégradé tiré de l'index, jamais un échec : après une mutation, le panneau le lirait comme
   * « rien n'a changé » ; à la lecture, il resterait muet, sans liste pour basculer ni remplacer la clé.
   */
  async function readInfo(): Promise<WorkspaceInfo> {
    try {
      return await deps.info()
    } catch (error) {
      deps.log(`workspace info unreadable, answered from the index: ${error instanceof Error ? error.message : String(error)}`)
      const index = await workspaces.index()
      const active = index.entries.find((entry) => entry.localId === index.activeLocalId)
      return {
        hasKey: (await workspaces.activeKey()) !== null,
        keyRejected: false,
        workspaceId: active?.workspaceId ?? null,
        organizationName: null,
        workspaces: index.entries.map((entry) => ({ ...entry, active: entry.localId === index.activeLocalId }))
      }
    }
  }

  /**
   * Une mutation réussie rend l'état frais du panneau ; une mutation refusée rend son erreur. Quand elle a changé
   * l'actif (`switched`), tous les panneaux en sont avertis avec ce même état.
   */
  async function infoAfter(result: ApiResult<unknown>, switched = false): Promise<ApiResult<WorkspaceInfo>> {
    if (!result.ok) {
      return result
    }
    const info = await readInfo()
    if (switched) {
      deps.announce(info)
    }
    return { ok: true, value: info }
  }

  async function add({ name, key }: { name: string; key: string }): Promise<ApiResult<WorkspaceInfo>> {
    await deps.ready
    const before = await workspaces.index()
    const result = await workspaces.add(name, key)
    // Le premier workspace ajouté devient actif : le sondeur n'avait rien à suivre jusque-là.
    const switched = result.ok && before.activeLocalId === null
    if (switched) {
      await switchWorkspace()
    }
    return infoAfter(result, switched)
  }

  async function rename({ localId, name }: { localId: string; name: string }): Promise<ApiResult<WorkspaceInfo>> {
    await deps.ready
    return infoAfter(await workspaces.rename(localId, name))
  }

  async function replaceKey({ localId, key }: { localId: string; key: string }): Promise<ApiResult<WorkspaceInfo>> {
    await deps.ready
    const result = await workspaces.replaceKey(localId, key)
    // Même workspace, autre clé : le client en cache est périmé et le sondeur, peut-être arrêté sur un 401, repart.
    if (result.ok && (await workspaces.index()).activeLocalId === localId) {
      store.reset()
      poller.start()
    }
    return infoAfter(result)
  }

  async function remove({ localId }: { localId: string }): Promise<ApiResult<WorkspaceInfo>> {
    await deps.ready
    const result = await workspaces.remove(localId)
    const switched = result.ok && result.value.activeChanged
    if (switched) {
      await switchWorkspace()
    }
    return infoAfter(result, switched)
  }

  async function activate({ localId }: { localId: string }): Promise<ApiResult<WorkspaceInfo>> {
    await deps.ready
    const result = await workspaces.activate(localId)
    const switched = result.ok && result.value.activeChanged
    if (switched) {
      await switchWorkspace()
    }
    return infoAfter(result, switched)
  }

  return {
    info: async (): Promise<WorkspaceInfo> => {
      await deps.ready
      return readInfo()
    },
    add,
    rename,
    replaceKey,
    remove,
    activate
  }
}
