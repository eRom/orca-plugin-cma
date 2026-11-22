// Worker du plugin : le seul côté qui a le réseau. Il détient la clé API et répond au panneau.
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceInfo } from './protocol'
import { SECRET_NAME, createClientStore, describeError, failure, workspaceInfo } from './worker/client'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const store = createClientStore(orca.secrets)

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
    await orca.secrets.set(SECRET_NAME, key.trim())
    store.reset()
    try {
      const info = await workspaceInfo(store)
      if (info.keyRejected) {
        // Une clé refusée ne reste pas en secret : le panneau remontre le formulaire.
        await orca.secrets.delete(SECRET_NAME)
        store.reset()
        return { ok: false as const, code: 'unauthorized' as const, error: 'The API key was rejected (401).' }
      }
      return { ok: true as const, value: info }
    } catch (error) {
      return failure(error)
    }
  })

  orca.panels.handle('key.clear', async () => {
    await orca.secrets.delete(SECRET_NAME)
    store.reset()
    return { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null }
  })

  orca.log('agent-claude-managed worker ready')
}
