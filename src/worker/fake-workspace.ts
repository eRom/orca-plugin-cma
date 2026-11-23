// Les workspaces d'un faux worker, pour les specs de brouillons : l'actif et l'entrée migrée se règlent à la main.
import type { DraftsWorkspace } from './drafts'

export function fakeWorkspace(initial: { active: string | null; legacy: string | null } = { active: 'ws-a', legacy: 'ws-a' }) {
  const state = {
    active: initial.active,
    legacy: initial.legacy,
    names: { 'ws-a': 'Default', 'ws-b': 'Orca-claude' } as Record<string, string>
  }
  const deps: DraftsWorkspace = {
    active: async () => state.active,
    legacy: async () => state.legacy,
    nameOf: async (localId) => state.names[localId] ?? null
  }
  return { state, deps }
}
