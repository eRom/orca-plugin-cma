// État du panneau : pile de navigation, réglages de l'accueil, avis d'erreur et identité du
// workspace. Les atomes `persist: 'plugin'` survivent à un redémarrage du module du panneau.
import { atom, plugin, read, set } from 'orca'
import type {
  ApiResult,
  ConfigKind,
  Money,
  Preview,
  SessionDetail,
  SessionRow,
  StreamState,
  ThreadRow,
  WorkspaceInfo
} from '../protocol'

export type NavEntry =
  | { view: 'home' }
  | { view: 'config'; kind: ConfigKind; id: string }
  | { view: 'memory'; memoryStoreId: string; memoryId: string }
  | { view: 'session'; sessionId: string }
  | { view: 'newSession' }
  | { view: 'newConfig'; kind: ConfigKind }
  | { view: 'credential'; vaultId: string; credentialId: string | null }

/** Onglets de l'accueil : les sessions, les quatre types de configuration, puis les ressources (skills et fichiers). */
export type HomeTab = 'sessions' | 'agent' | 'environment' | 'memory_store' | 'vault' | 'resources'

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

/**
 * Dépile la vue courante seulement si c'est encore celle d'origine (`matches`). À appeler après un `await` :
 * si la personne a appuyé sur Back entre-temps, dépiler encore retirerait une vue de trop. Dit si elle a dépilé.
 */
export function popIfTop(matches: (entry: NavEntry) => boolean): boolean {
  const stack = read(nav)
  const top = stack[stack.length - 1]
  if (stack.length < 2 || top === undefined || !matches(top)) {
    return false
  }
  set(nav, popView(stack))
  return true
}
export const homeTab = atom<HomeTab>('home.tab', 'sessions', { persist: 'plugin' })
/** Le texte du filtre de chaque onglet de l'accueil : un onglet sans entrée a un filtre vide. */
export const homeFilters = atom<Partial<Record<HomeTab, string>>>('home.filters', {}, { persist: 'plugin' })

export const filterOf = (tab: HomeTab): string => read(homeFilters)[tab] ?? ''

export function setFilterOf(tab: HomeTab, value: string): void {
  set(homeFilters, { ...read(homeFilters), [tab]: value })
}
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

/** Texte d'erreur de l'API borné pour un `Text` : un plafond d'Orca dépassé refuserait tout le rendu. */
export const ERROR_TEXT_LIMIT_BYTES = 8_000

/** Plafonds d'un titre et d'un sous-titre de ligne : un libellé de plus de 1 Kio fait refuser le rendu. */
export const ROW_TITLE_LIMIT_BYTES = 200
export const ROW_SUBTITLE_LIMIT_BYTES = 300

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

// --- Vue d'une session : tout ceci est éphémère (rien n'est persisté), le worker garde le fil. ---

/** Session dont la vue est ouverte ; les poussées des autres sessions sont ignorées. */
export const viewedSession = atom<string | null>(null)
/** Lignes du fil connues du panneau, de la plus ancienne à la plus récente. */
export const threadRows = atom<ThreadRow[]>([])
/** Messages en cours d'écriture (état complet à chaque poussée). */
export const previews = atom<Preview[]>([])
/** Fin (exclusive) de la page affichée ; null = les lignes les plus récentes. */
export const pageEnd = atom<number | null>(null)
/** Vrai quand le worker garde des lignes plus anciennes que celles du panneau. */
export const hasEarlier = atom(false)
export const streamState = atom<StreamState | null>(null)
export const sessionDetail = atom<SessionDetail | null>(null)
/** Coût et budget les plus frais : `session.updated` ou `session.detail`, le dernier arrivé gagne. */
export const sessionUsage = atom<{ cost: Money | null; budget: Money | null } | null>(null)
/** Vrai une fois la première réponse de `session.watch` reçue (réussie ou non). */
export const threadLoaded = atom(false)
export const loadingEarlier = atom(false)
/** Vrai pendant l'envoi d'un message : une session est facturée, un double envoi coûte. */
export const sending = atom(false)
/** Texte du composeur. */
export const draft = atom('')
/** Motif de refus saisi, par id d'appel d'outil. */
export const denyDraft = atom<Record<string, string>>({})
/** Appels d'outil dont l'accord ou le refus est en route. */
export const confirming = atom<string[]>([])
export const raiseDraft = atom('')
/** Erreur du relèvement de budget, affichée dans son propre formulaire. */
export const raiseNotice = atom<string | null>(null)
/** Erreur d'une action de la session, affichée près du composeur. */
export const sessionNotice = atom<string | null>(null)
/** Clé de la confirmation ouverte (`ConfirmAction`, `ConfirmPanel`) ; une seule à la fois. Éphémère. */
export const pendingConfirmation = atom<string | null>(null)
/** Section « Manage session »(archiver, supprimer) : fermée à chaque nouvelle session. */
export const manageOpen = atom(false)
/** Refus de l'API à l'archivage ou à la suppression, affiché sous les gestes de `Manage session`, là où la personne regarde. */
export const manageNotice = atom<{ action: 'archive' | 'delete'; message: string } | null>(null)

/**
 * Remet la vue à zéro pour une session (ou aucune). Rouvrir la session déjà affichée (worker redémarré,
 * suivi perdu) garde ce que la personne a tapé, les gardes des envois en route et les erreurs affichées :
 * sans elles, un texte gardé inviterait au double envoi d'un message facturé.
 */
export function resetSessionView(sessionId: string | null): void {
  const reopening = sessionId !== null && read(viewedSession) === sessionId
  set(viewedSession, sessionId)
  set(threadRows, [])
  set(previews, [])
  set(pageEnd, null)
  set(hasEarlier, false)
  set(streamState, null)
  set(sessionDetail, null)
  set(sessionUsage, null)
  set(threadLoaded, false)
  set(loadingEarlier, false)
  if (reopening) return
  set(raiseNotice, null)
  set(sessionNotice, null)
  set(manageOpen, false)
  set(manageNotice, null)
  set(sending, false)
  set(draft, '')
  set(denyDraft, {})
  set(confirming, [])
  set(raiseDraft, '')
  // Les clés sont propres à une entité (`session:<id>:archive`) et une seule question est ouverte à la fois :
  // celle d'une session ne survit pas à sa vue ; la question d'une autre vue (agent, mémoire) n'est pas touchée.
  if (read(pendingConfirmation)?.startsWith('session:')) set(pendingConfirmation, null)
}

/** Remplace les lignes déjà connues par id, ajoute les autres à la fin. Ne coupe jamais la liste. */
export function mergeRows(current: readonly ThreadRow[], incoming: readonly ThreadRow[]): ThreadRow[] {
  const next = [...current]
  const indexById = new Map(next.map((row, index) => [row.id, index]))
  for (const row of incoming) {
    const index = indexById.get(row.id)
    if (index === undefined) {
      indexById.set(row.id, next.length)
      next.push(row)
    } else {
      next[index] = row
    }
  }
  return next
}

/** Place en tête les lignes plus anciennes pas encore connues ; renvoie la liste et le nombre ajouté. */
export function prependRows(
  current: readonly ThreadRow[],
  older: readonly ThreadRow[]
): { rows: ThreadRow[]; added: number } {
  const known = new Set(current.map((row) => row.id))
  const fresh = older.filter((row) => !known.has(row.id))
  return { rows: [...fresh, ...current], added: fresh.length }
}
