// État et lectures de l'onglet Resources : les skills et les fichiers du workspace actif.
// Séparé des vues comme `config-state.ts` l'est de `config-views.tsx`. Ce fichier n'importe ni `config-state.ts`
// (qui importe `loadResources` d'ici) ni `resources.tsx` : aucun import circulaire.
import { atom, plugin, read, set, type Atom } from 'orca'
import type { ApiResult, FileRow, SkillRow } from '../protocol'
import { loadWorkspace, pendingConfirmation, workspace } from './state'

/** Lignes de chaque carte ; `null` tant que la première lecture n'est pas revenue (la carte montre un Spinner). */
export const skillRows = atom<SkillRow[] | null>('resources.skills', null)
export const fileRows = atom<FileRow[] | null>('resources.files', null)
/** Erreur de lecture de chaque liste ; les lignes déjà lues restent affichées. */
export const resourceErrors = atom<{ skills: string | null; files: string | null }>('resources.errors', {
  skills: null,
  files: null
})

/** Les deux cartes de l'onglet. */
export type CardKey = 'skills' | 'files'

/** L'avis d'une carte : il reste jusqu'à la prochaine action sur cette carte. `message` est le corps d'un refus. */
export type CardNotice = { tone: 'success' | 'warning' | 'danger'; title: string; message: string | null }

type PerCard<T> = Record<CardKey, T>

export const resourceNotices = atom<PerCard<CardNotice | null>>('resources.notices', { skills: null, files: null })
/** Le libellé de l'envoi en route de chaque carte (`null` au repos) : il grise les boutons d'envoi et nourrit le spinner. */
export const resourceUploading = atom<PerCard<string | null>>('resources.uploading', { skills: null, files: null })
/** Vrai tant que la boîte de choix d'une carte est ouverte : le worker n'en garde qu'une, un second choix serait le même. */
export const resourcePicking = atom<PerCard<boolean>>('resources.picking', { skills: false, files: false })

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
  set(resourceErrors, { skills: null, files: null })
  set(resourceNotices, { skills: null, files: null })
  set(resourceUploading, { skills: null, files: null })
  set(resourcePicking, { skills: false, files: false })
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

export function loadFiles(): Promise<void> {
  return readList('files', () => plugin.request('files.list'), fileRows)
}

/** Les deux listes en parallèle. */
export async function loadResources(): Promise<void> {
  await Promise.all([loadSkills(), loadFiles()])
}
