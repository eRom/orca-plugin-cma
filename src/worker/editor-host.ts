// Pilotage de l'éditeur d'Orca depuis le worker : retrouver le dossier de brouillons parmi les
// workspaces, montrer ce workspace, y ouvrir un fichier. Aucun hôte ne sait ajouter un workspace :
// c'est Romain qui ajoute le dossier (`orca repo add --path X --kind folder`).
import type { OrcaWorkerApi } from 'orca/worker'

export type EditorHost = {
  /** Les workspaces de cette machine (`hostId` `local`, ou aucun) avec leur chemin. */
  folders(): Promise<{ id: string; name: string; path: string }[]>
  /** Les projets de la barre latérale d'Orca, tels que `project.list` les rend (le filtre local et masqué vit dans `drafts-location`). */
  projects(): Promise<{ id: string; name: string; kind: 'git' | 'folder'; hostId: string | null; path: string; hidden?: boolean }[]>
  /** Le workspace qui a le focus ; null quand aucun. */
  focused(): Promise<{ workspaceId: string; name: string } | null>
  /** Montre le workspace dans la fenêtre d'Orca. */
  show(workspaceId: string): Promise<void>
  /** Ouvre un fichier dans un onglet d'éditeur de ce workspace ; `path` est relatif au workspace. */
  open(workspaceId: string, path: string): Promise<void>
}

export function createEditorHost(host: OrcaWorkerApi['host']): EditorHost {
  return {
    async folders() {
      const answer = await host.call('workspace.list', {})
      return answer.workspaces
        .filter((row) => row.hostId === 'local' || row.hostId === null)
        .map(({ id, name, path }) => ({ id, name, path }))
    },

    async projects() {
      const answer = await host.call('project.list', {})
      return answer.projects.map(({ id, name, kind, hostId, path, hidden }) => ({ id, name, kind, hostId, path, hidden }))
    },

    async focused() {
      const context = await host.call('workspace.readContext', {})
      if (!context || !context.workspaceId) {
        return null
      }
      return { workspaceId: context.workspaceId, name: context.displayName }
    },

    async show(workspaceId) {
      await host.call('workspace.open', { workspaceId })
    },

    // `editor.open` seul ajoute l'onglet sans l'afficher (essai du 22/11, `runs/lot2-spike`) :
    // l'appelant montre d'abord le workspace.
    async open(workspaceId, path) {
      await host.call('editor.open', { workspaceId, path })
    }
  }
}

/** Ce dont les brouillons ont besoin de l'hôte : tout sauf la liste des projets, qui sert au choix du dossier. */
export type DraftsHost = Omit<EditorHost, 'projects'>
