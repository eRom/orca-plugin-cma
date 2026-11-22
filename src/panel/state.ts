// État du panneau : pile de navigation, réglages de l'accueil, avis d'erreur et identité du
// workspace. Les atomes `persist: 'plugin'` survivent à un redémarrage du module du panneau.
import { atom, plugin, read, set } from 'orca'
import type { ApiResult, ConfigKind, SessionRow, WorkspaceInfo } from '../protocol'

export type NavEntry =
  | { view: 'home' }
  | { view: 'config'; kind: ConfigKind; id: string }
  | { view: 'memory'; memoryStoreId: string; memoryId: string }
  | { view: 'session'; sessionId: string }
  | { view: 'newSession' }

export type HomeTab = 'agent' | 'environment' | 'memory_store' | 'vault'

/** Profondeur maximale : accueil, un détail, une mémoire ouverte depuis une banque. */
const MAX_DEPTH = 3

/** Empile une vue. Au-delà de la profondeur maximale, on garde l'accueil et les dernières vues. */
export function pushView(stack: NavEntry[], entry: NavEntry): NavEntry[] {
  const next = [...stack, entry]
  return next.length > MAX_DEPTH ? [next[0] as NavEntry, ...next.slice(-(MAX_DEPTH - 1))] : next
}

/** Dépile la vue courante ; l'accueil reste toujours au fond. */
export function popView(stack: NavEntry[]): NavEntry[] {
  return stack.length > 1 ? stack.slice(0, -1) : stack
}

export const nav = atom<NavEntry[]>('nav', [{ view: 'home' }], { persist: 'plugin' })
export const homeTab = atom<HomeTab>('home.tab', 'agent', { persist: 'plugin' })
export const homeFilter = atom('home.filter', '', { persist: 'plugin' })
export const sectionsOpen = atom(
  'home.sections',
  { workspace: false, configurations: true, sessions: true },
  { persist: 'plugin' }
)

/** Identité du workspace ; null tant que le worker n'a pas répondu. */
export const workspace = atom<WorkspaceInfo | null>(null)

/** Avis d'erreur affiché en haut du panneau. */
export const notice = atom<string | null>(null)

/** Lit une réponse de l'API : son erreur devient l'avis affiché en haut du panneau. */
export function unwrap<T>(result: ApiResult<T>): T | null {
  if (result.ok) {
    return result.value
  }
  set(notice, result.error)
  return null
}

/** Lance une action du panneau ; un refus d'Orca ou du worker s'affiche au lieu de se perdre. */
export function run(action: () => Promise<void>): void {
  set(notice, null)
  action().catch((error: unknown) => set(notice, error instanceof Error ? error.message : String(error)))
}

export async function loadWorkspace(): Promise<void> {
  set(workspace, await plugin.request('workspace.info'))
}

/** Les sessions telles que le worker les voit (le worker les pousse par `sessions.changed`) ; null avant la première lecture. */
export const sessionRows = atom<SessionRow[] | null>('sessions.rows', null)

/**
 * Lit la liste des sessions. Sans clé utilisable, il n'y a rien à lire. Un 401 est l'état « clé
 * refusée » : on relit l'identité du workspace, qui remontre le formulaire.
 */
export async function loadSessions(): Promise<void> {
  const info = read(workspace)
  if (!info?.hasKey || info.keyRejected) {
    return
  }
  const result = await plugin.request('sessions.list')
  if (result.ok) {
    set(sessionRows, result.value)
  } else if (result.code === 'unauthorized') {
    await loadWorkspace()
  } else {
    set(notice, result.error)
  }
}
