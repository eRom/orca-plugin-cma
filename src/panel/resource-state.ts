// État et lectures de l'onglet Resources : les skills et les fichiers du workspace actif.
// Séparé des vues comme `config-state.ts` l'est de `config-views.tsx`. Ce fichier n'importe ni `config-state.ts`
// (qui importe `loadResources` d'ici) ni `resources.tsx` : aucun import circulaire.
import { atom, plugin, read, set, type Atom } from 'orca'
import type { ApiResult, FileRow, SkillRow } from '../protocol'
import { loadWorkspace, pendingConfirmation, workspace } from './state'

/** Lignes de chaque carte ; `null` tant que la première lecture n'est pas revenue (la carte montre un Spinner). */
export const skillRows = atom<SkillRow[] | null>('resources.skills', null)
export const fileRows = atom<FileRow[] | null>('resources.files', null)
/** Les skills d'Anthropic, lus pour le formulaire d'agent seulement (l'onglet Resources ne les montre pas) ; `null` tant qu'ils ne sont pas lus. */
export const anthropicSkillRows = atom<SkillRow[] | null>('resources.anthropicSkills', null)
/** Erreur de lecture de chaque liste ; les lignes déjà lues restent affichées. */
export const resourceErrors = atom<{ skills: string | null; files: string | null }>('resources.errors', {
  skills: null,
  files: null
})

/** Les deux cartes de l'onglet. */
export type CardKey = 'skills' | 'files'

/**
 * L'avis d'une carte. Un succès s'efface seul au bout de SUCCESS_NOTICE_MS ; un refus ou un avertissement reste
 * jusqu'à la prochaine action sur la carte, il demande une lecture. `message` est le corps d'un refus.
 */
export type CardNotice = { tone: 'success' | 'warning' | 'danger'; title: string; message: string | null }

type PerCard<T> = Record<CardKey, T>

export const resourceNotices = atom<PerCard<CardNotice | null>>('resources.notices', { skills: null, files: null })

/** Durée d'affichage d'un succès, choisie par Romain après la passe en vrai du 24/11. */
export const SUCCESS_NOTICE_MS = 3000

const noticeTimers: PerCard<ReturnType<typeof setTimeout> | null> = { skills: null, files: null }

/**
 * Pose (ou retire, avec `null`) l'avis d'une carte. Le minuteur précédent de la carte est annulé ; un succès en
 * programme un nouveau, qui ne retire l'avis que s'il est encore celui posé ici, jamais un avis plus récent.
 */
export function showNotice(card: CardKey, notice: CardNotice | null, successMs = SUCCESS_NOTICE_MS): void {
  const previous = noticeTimers[card]
  if (previous !== null) clearTimeout(previous)
  noticeTimers[card] = null
  setCardValue(resourceNotices, card, notice)
  if (notice?.tone !== 'success') return
  noticeTimers[card] = setTimeout(() => {
    noticeTimers[card] = null
    if (read(resourceNotices)[card] === notice) setCardValue(resourceNotices, card, null)
  }, successMs)
}

/** Le libellé de l'envoi en route de chaque carte (`null` au repos) : il grise les boutons d'envoi et nourrit le spinner. */
export const resourceUploading = atom<PerCard<string | null>>('resources.uploading', { skills: null, files: null })
/** Vrai tant que la boîte de choix d'une carte est ouverte : le worker n'en garde qu'une, un second choix serait le même. */
export const resourcePicking = atom<PerCard<boolean>>('resources.picking', { skills: false, files: false })

/** Le champ de chemin d'une carte (sans boîte de choix sur l'ordinateur) : ce qu'il enverra. `skill` non nul : une nouvelle version de celle-ci. `null` : champ fermé. */
export type PathTarget = { skill: { id: string; name: string } | null }
export const resourcePathTarget = atom<PerCard<PathTarget | null>>('resources.pathTarget', { skills: null, files: null })
/** Le texte tapé dans le champ de chemin de chaque carte. */
export const resourcePathDraft = atom<PerCard<string>>('resources.pathDraft', { skills: '', files: '' })

/** Écrit la valeur d'une seule carte dans un atome « par carte ». */
export function setCardValue<T>(target: Atom<PerCard<T>>, card: CardKey, value: T): void {
  set(target, { ...read(target), [card]: value })
}

/**
 * Change à chaque bascule de workspace : une réponse partie sous l'ancienne génération ne repeint pas le nouveau.
 * Chaque liste numérote en plus ses demandes : seule la dernière lance l'écriture, une relecture lente ne repeint
 * donc pas une liste plus fraîche.
 */
let generation = 0
const lastRequest = { skills: 0, files: 0 }

export function currentGeneration(): number {
  return generation
}

/** Filtre sur le nom ou l'identifiant, sans tenir compte de la casse ; une requête vide garde tout. */
export function filterResources<T extends { id: string; name: string }>(rows: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter((row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
}

/**
 * Oublie ce que les cartes montraient (workspace changé) : lignes à `null`, erreurs et avis vidés, envois et choix
 * oubliés, question de suppression fermée, réponses en vol périmées.
 */
export function resetResources(): void {
  generation += 1
  set(skillRows, null)
  set(fileRows, null)
  set(anthropicSkillRows, null)
  set(resourceErrors, { skills: null, files: null })
  showNotice('skills', null)
  showNotice('files', null)
  set(resourceUploading, { skills: null, files: null })
  set(resourcePicking, { skills: false, files: false })
  set(resourcePathTarget, { skills: null, files: null })
  set(resourcePathDraft, { skills: '', files: '' })
  const pending = read(pendingConfirmation)
  if (pending?.startsWith('skill:') || pending?.startsWith('file:')) set(pendingConfirmation, null)
}

/**
 * Lit une liste. Sans clé utilisable il n'y a rien à lire ; un 401 est l'état « clé refusée » : on relit l'identité
 * du workspace, qui remontre le formulaire. Une réponse qui n'est plus la dernière demandée, ou qui vient d'un
 * workspace quitté depuis, est ignorée.
 */
async function readList<T>(
  key: 'skills' | 'files',
  request: () => Promise<ApiResult<T[]>>,
  rows: Atom<T[] | null>
): Promise<void> {
  const info = read(workspace)
  if (!info?.hasKey || info.keyRejected) return
  const startedIn = generation
  const ticket = ++lastRequest[key]
  const result = await request()
  if (startedIn !== generation || ticket !== lastRequest[key]) return
  if (result.ok) {
    set(rows, result.value)
    set(resourceErrors, { ...read(resourceErrors), [key]: null })
  } else if (result.code === 'unauthorized') {
    await loadWorkspace()
  } else {
    set(resourceErrors, { ...read(resourceErrors), [key]: result.error })
  }
}

export function loadSkills(): Promise<void> {
  return readList('skills', () => plugin.request('skills.list'), skillRows)
}

/**
 * Lit les skills d'Anthropic. Une lecture de fond : un échec laisse la liste à `null` (le menu du formulaire n'offre
 * alors que les skills de l'espace) et la prochaine ouverture d'un agent la relit. Une réponse d'un workspace quitté
 * depuis est ignorée.
 */
export async function loadAnthropicSkills(): Promise<void> {
  const info = read(workspace)
  if (!info?.hasKey || info.keyRejected) return
  const startedIn = generation
  const result = await plugin.request('skills.listAnthropic')
  if (startedIn !== generation) return
  if (result.ok) set(anthropicSkillRows, result.value)
  else if (result.code === 'unauthorized') await loadWorkspace()
}

export function loadFiles(): Promise<void> {
  return readList('files', () => plugin.request('files.list'), fileRows)
}

/** Les deux listes en parallèle. */
export async function loadResources(): Promise<void> {
  await Promise.all([loadSkills(), loadFiles()])
}
