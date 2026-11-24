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

/** Longueur maximale d'un chemin collé : au-delà d'un chemin réel, avant qu'un texte énorme n'alourdisse l'état ou le rendu. */
export const PATH_MAX_LENGTH = 4096

/**
 * Ce que collent l'Explorateur Windows (« Copier en tant que chemin » : le chemin entre guillemets doubles) et les
 * gestionnaires de fichiers Linux (une URL `file://`, caractères encodés en %XX) : le chemin nu.
 */
function bareFilePath(value: string): string {
  let path = value.trim()
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).trim()
  }
  const url = /^file:\/\/(?:localhost(?=\/))?/i.exec(path)
  if (url === null) return path
  const rest = path.slice(url[0].length)
  let decoded = rest
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    // Un « % » qui n'encode rien : le texte reste tel que collé.
  }
  // `file:///C:/Users/x` : la barre qui précède la lettre du lecteur n'est pas une partie du chemin.
  return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded
}

/**
 * Le chemin collé devient un choix comme celui d'une boîte : le chemin sans espaces de bord, ni guillemets doubles qui
 * l'entourent, ni préfixe `file://` (décodé), et son dernier segment pour nom (après `/` ou `\`, séparateurs de fin
 * ignorés). `null` quand il ne reste rien.
 */
export function pickedFromPath(value: string): PickedFile | null {
  const file = bareFilePath(value)
  if (file === '') return null
  const segments = file.split(/[\\/]/).filter((segment) => segment !== '')
  return { file, name: segments.at(-1) ?? file }
}
