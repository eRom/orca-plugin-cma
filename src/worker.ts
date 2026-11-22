// Worker du plugin : le seul côté qui a le réseau. Il détient la clé API et répond au panneau.
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceInfo } from './protocol'
import { SECRET_NAME, createClientStore, describeError, setKey, workspaceInfo } from './worker/client'

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

  orca.panels.handle('key.set', ({ key }) => setKey(orca.secrets, store, key))

  orca.panels.handle('key.clear', async () => {
    await orca.secrets.delete(SECRET_NAME)
    store.reset()
    return { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null }
  })

  orca.log('agent-claude-managed worker ready')
}
