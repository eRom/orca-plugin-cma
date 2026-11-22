// État et lectures des configurations : listes de l'accueil, détail ouvert, ouverture d'une vue.
// Séparé des vues pour que les formulaires (environnement, coffre, identifiant) importent l'état
// sans repasser par `config-views`, qui les rend : aucun import circulaire.
import { atom, plugin, read, set, update } from 'orca'
import type { ConfigDetail, ConfigKind, ConfigRow } from '../protocol'
import { loadWorkspace, nav, pushView, run, workspace } from './state'

/**
 * Lignes dessinées au plus par liste : un rendu est refusé au-delà de 5000 nœuds et d'environ
 * 512 Kio. Une banque de mémoire peut garder bien plus de mémoires que cela.
 */
export const RENDER_ROW_CAP = 200

/** Lignes des listes de l'accueil, par type ; absent tant que la première lecture n'est pas revenue. */
export const configRows = atom<Partial<Record<ConfigKind, ConfigRow[]>>>('configs.rows', {})
/** Erreur de lecture de la liste, par type. */
export const configErrors = atom<Partial<Record<ConfigKind, string | null>>>('configs.errors', {})
/** Détail de la configuration ouverte ; il reste chargé quand une mémoire ou un identifiant s'ouvre par-dessus. */
export const configDetail = atom<ConfigDetail | null>('configs.detail', null)
export const configDetailError = atom<string | null>('configs.detail.error', null)

/** Oublie les listes lues (clé changée ou oubliée) : elles ne valent plus pour la nouvelle clé. */
export function resetConfigs(): void {
  set(configRows, {})
  set(configErrors, {})
}

/**
 * Lit la liste d'un type. Sans clé utilisable il n'y a rien à lire ; un 401 est l'état « clé
 * refusée » : on relit l'identité du workspace, qui remontre le formulaire. Les lignes déjà lues
 * restent affichées pendant la relecture.
 */
export async function loadConfigs(kind: ConfigKind): Promise<void> {
  const info = read(workspace)
  if (!info?.hasKey || info.keyRejected) return
  const result = await plugin.request('configs.list', { kind })
  if (result.ok) {
    update(configRows, (current) => ({ ...current, [kind]: result.value }))
    update(configErrors, (current) => ({ ...current, [kind]: null }))
  } else if (result.code === 'unauthorized') {
    await loadWorkspace()
  } else {
    update(configErrors, (current) => ({ ...current, [kind]: result.error }))
  }
}

/** Vrai tant que la vue au sommet de la pile est cette configuration, ou un identifiant de ce coffre. */
function isConfigOnTop(kind: ConfigKind, id: string): boolean {
  const top = read(nav).at(-1)
  if (top?.view === 'credential') return kind === 'vault' && top.vaultId === id
  return top?.view === 'config' && top.kind === kind && top.id === id
}

/** Relit le détail d'une configuration ; les formulaires s'en servent après une écriture. */
export async function loadDetail(kind: ConfigKind, id: string): Promise<void> {
  set(configDetail, null)
  set(configDetailError, null)
  const result = await plugin.request('configs.detail', { kind, id })
  // Retour ou autre vue ouverte pendant la lecture : cette réponse ne sert plus.
  if (!isConfigOnTop(kind, id)) return
  if (result.ok) {
    set(configDetail, result.value)
  } else {
    set(configDetailError, result.error)
  }
}

/** Ouvre le détail d'une configuration depuis l'accueil : empile la vue, puis la charge. */
export function openConfig(kind: ConfigKind, id: string): void {
  update(nav, (stack) => pushView(stack, { view: 'config', kind, id }))
  run(() => loadDetail(kind, id))
}

/** Ouvre le formulaire d'un identifiant du coffre ouvert (`credentialId` null : un nouvel identifiant). */
export function openCredential(vaultId: string, credentialId: string | null): void {
  update(nav, (stack) => pushView(stack, { view: 'credential', vaultId, credentialId }))
}
