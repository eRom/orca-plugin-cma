// Repli quand l'ordinateur n'a aucune boîte de choix de fichier (le worker répond `picker_unavailable`) : la personne
// colle le chemin. Partagé par les cartes Resources et les lignes d'envoi de mémoire.
import { atom } from 'orca'
import type { PickedFile } from '../protocol'

/**
 * Vrai dès qu'un choix a été refusé faute de boîte. Éphémère (jamais persisté) : l'ordinateur ne change pas en cours
 * de route, mais un redémarrage du panneau redemande une fois, ce qui suit un outil installé entre-temps.
 */
export const pickerUnavailable = atom<boolean>(false)

/** Le texte du champ pour un fichier (carte Files, lignes de mémoire) ou un dossier (carte Skills). */
export const FILE_PATH_PLACEHOLDER = 'Paste the full path of the file'
export const FOLDER_PATH_PLACEHOLDER = 'Paste the full path of the folder'

/**
 * Le chemin collé devient un choix comme celui d'une boîte : le chemin sans espaces de bord, et son dernier segment pour
 * nom (après `/` ou `\`, séparateurs de fin ignorés). `null` quand il ne reste rien.
 */
export function pickedFromPath(value: string): PickedFile | null {
  const file = value.trim()
  if (file === '') return null
  const segments = file.split(/[\\/]/).filter((segment) => segment !== '')
  return { file, name: segments.at(-1) ?? file }
}
