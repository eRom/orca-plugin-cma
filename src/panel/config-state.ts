// État et lectures des configurations : listes de l'accueil, détail ouvert, ouverture d'une vue.
// Séparé des vues pour que les formulaires (environnement, coffre, identifiant) importent l'état
// sans repasser par `config-views`, qui les rend : aucun import circulaire.
import { atom, plugin, read, set, update } from 'orca'
import type { ConfigDetail, ConfigKind, ConfigRow, DraftRef, MemoryContent, MemoryStoreDetail } from '../protocol'
import { loadDraftControls, refreshDraftsStatus, refreshDraftState } from './drafts'
import { loadResources } from './resource-state'
import { homeTab, loadWorkspace, nav, pushView, run, workspace } from './state'

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

/** Les modèles que le formulaire d'agent propose ; null tant que la lecture n'a pas abouti (le formulaire offre alors un champ libre). */
export const agentModels = atom<string[] | null>(null)

/** Oublie les listes lues (clé changée ou oubliée) : elles ne valent plus pour la nouvelle clé. */
export function resetConfigs(): void {
  set(configRows, {})
  set(configErrors, {})
  set(agentModels, null)
}

/** Lit la liste de l'onglet d'accueil, s'il en montre une ; les sessions ont leur propre lecture. */
export function loadConfigTab(): Promise<void> {
  const tab = read(homeTab)
  if (tab === 'sessions') return Promise.resolve()
  return tab === 'resources' ? loadResources() : loadConfigs(tab)
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
    if (result.value.kind === 'memory_store') await loadStoreDrafts(result.value)
    if (result.value.kind === 'agent') await loadAgentExtras(result.value.id)
  } else {
    set(configDetailError, result.error)
  }
}

// --- Brouillons des mémoires d'une banque ---

/**
 * À l'ouverture du détail d'une banque : relit l'état du dossier de brouillons et celui du brouillon de chaque mémoire
 * listée (le registre du worker seul répond, sans réseau), pour que la ligne d'une mémoire au brouillon non appliqué le dise
 * après un redémarrage du panneau. Une lecture de fond : un échec laisse l'état inconnu.
 */
async function loadStoreDrafts(store: MemoryStoreDetail): Promise<void> {
  await Promise.all([
    refreshDraftsStatus().catch(() => {}),
    ...store.memories.slice(0, RENDER_ROW_CAP).map((memory) => refreshDraftState(memoryDraft(store.id, memory.id, memory.path)).catch(() => {}))
  ])
}

// --- Formulaire d'agent ---

/**
 * Lit les modèles que l'API propose, une fois par clé. Une lecture de fond : un échec laisse la liste inconnue,
 * et le formulaire offre un champ libre pour le modèle.
 */
export async function loadAgentModels(): Promise<void> {
  if (read(agentModels) !== null) return
  try {
    const result = await plugin.request('agent.formOptions')
    if (result.ok) set(agentModels, result.value.models)
    else if (result.code === 'unauthorized') await loadWorkspace()
  } catch {
    // Rien à montrer : le champ libre prend le relais.
  }
}

/** À l'ouverture d'un écran d'agent (détail ou création) : les modèles et l'état du brouillon YAML. `agentId` null : un nouvel agent. */
async function loadAgentExtras(agentId: string | null): Promise<void> {
  await Promise.all([loadAgentModels(), loadDraftControls({ kind: 'agent', agentId })])
}

/** Ouvre le formulaire de création d'un agent : empile la vue, puis charge ce qu'elle lit. */
export function openNewAgent(): void {
  update(nav, (stack) => pushView(stack, { view: 'newConfig', kind: 'agent' }))
  run(() => loadAgentExtras(null))
}

/** Rouvre le formulaire de création d'un agent resté au sommet de la pile (redémarrage du panneau). */
export function restoreNewAgent(): Promise<void> {
  const top = read(nav).at(-1)
  return top?.view === 'newConfig' && top.kind === 'agent' ? loadAgentExtras(null) : Promise.resolve()
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
