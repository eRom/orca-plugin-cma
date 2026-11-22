// État et lectures des configurations : listes de l'accueil, détail ouvert, ouverture d'une vue.
// Séparé des vues pour que les formulaires (environnement, coffre, identifiant) importent l'état
// sans repasser par `config-views`, qui les rend : aucun import circulaire.
import { atom, plugin, read, set, update } from 'orca'
import type { ConfigDetail, ConfigKind, ConfigRow, DraftRef, MemoryContent, MemoryStoreDetail } from '../protocol'
import { draftHasFlow, loadDraftControls } from './drafts'
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
    if (result.value.kind === 'memory_store') await restoreNewMemory(result.value)
  } else {
    set(configDetailError, result.error)
  }
}

// --- Nouvelle mémoire en cours ---

/** Où en est la nouvelle mémoire d'une banque : le chemin demandé, puis le brouillon, puis son succès. Jamais de contenu. */
export type NewMemoryEntry = { phase: 'asking' | 'editing' | 'applied'; path: string }

/**
 * Les nouvelles mémoires en cours, par identifiant de banque. Persisté : après un redémarrage du panneau, un
 * brouillon non appliqué reste atteignable depuis sa banque sans retaper son chemin.
 */
export const newMemories = atom<Record<string, NewMemoryEntry>>('memory.new', {}, { persist: 'plugin' })

/** Le brouillon d'une mémoire pas encore créée. */
export function newMemoryRef(memoryStoreId: string, path: string): DraftRef {
  return { kind: 'memory', memoryStoreId, memoryId: null, path }
}

export function setNewMemory(storeId: string, entry: NewMemoryEntry | null): void {
  update(newMemories, (entries) => {
    const { [storeId]: _dropped, ...rest } = entries
    return entry === null ? rest : { ...rest, [storeId]: entry }
  })
}

/**
 * À l'ouverture du détail d'une banque : une entrée dont la mémoire existe déjà (et dont aucun succès n'est
 * affiché) est oubliée ; une entrée au stade du brouillon relit l'état de son brouillon, que `DraftControls` affiche.
 */
async function restoreNewMemory(store: MemoryStoreDetail): Promise<void> {
  const entry = read(newMemories)[store.id]
  if (entry === undefined || entry.phase === 'asking') return
  const ref = newMemoryRef(store.id, entry.path)
  if (store.memories.some((memory) => memory.path === entry.path) && !draftHasFlow(ref)) {
    setNewMemory(store.id, null)
    return
  }
  if (entry.phase === 'editing') await loadDraftControls(ref)
}

/** Ouvre le détail d'une configuration depuis l'accueil : empile la vue, puis la charge. */
export function openConfig(kind: ConfigKind, id: string): void {
  update(nav, (stack) => pushView(stack, { view: 'config', kind, id }))
  run(() => loadDetail(kind, id))
}

// --- Mémoire ouverte ---

/** La mémoire ouverte ; null tant que sa lecture n'est pas revenue. */
export const memoryContent = atom<MemoryContent | null>('configs.memory', null)
export const memoryError = atom<string | null>('configs.memory.error', null)

/** Le brouillon d'une mémoire existante. */
export function memoryDraft(memoryStoreId: string, memoryId: string, path: string): DraftRef {
  return { kind: 'memory', memoryStoreId, memoryId, path }
}

/**
 * Lit la mémoire ouverte, puis l'état de son brouillon. `keep` garde le contenu affiché pendant la
 * relecture (après une écriture) : sans lui, la vue repasse par « Loading memory ».
 */
export async function loadMemory(memoryStoreId: string, memoryId: string, keep = false): Promise<void> {
  if (!keep) set(memoryContent, null)
  set(memoryError, null)
  const result = await plugin.request('memory.read', { memoryStoreId, memoryId })
  const top = read(nav).at(-1)
  if (top?.view !== 'memory' || top.memoryStoreId !== memoryStoreId || top.memoryId !== memoryId) return
  if (result.ok) {
    set(memoryContent, result.value)
    await loadDraftControls(memoryDraft(memoryStoreId, memoryId, result.value.path))
  } else {
    set(memoryError, result.error)
  }
}

/** Ouvre une mémoire depuis le détail de sa banque. */
export function openMemory(memoryStoreId: string, memoryId: string): void {
  update(nav, (stack) => pushView(stack, { view: 'memory', memoryStoreId, memoryId }))
  run(() => loadMemory(memoryStoreId, memoryId))
}

/** Ouvre le formulaire d'un identifiant du coffre ouvert (`credentialId` null : un nouvel identifiant). */
export function openCredential(vaultId: string, credentialId: string | null): void {
  update(nav, (stack) => pushView(stack, { view: 'credential', vaultId, credentialId }))
}
