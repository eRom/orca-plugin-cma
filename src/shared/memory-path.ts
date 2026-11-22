// Le chemin d'une mémoire : la règle vit ici pour que le panneau la lise avant tout envoi et que le
// worker la rejoue avant d'écrire un fichier. Fichier pur : aucun import, aucun accès au disque.

export const INVALID_MEMORY_PATH = 'A memory path starts with / and has no . or .. segments.'

/** Plafonds de l'API (`MemoryCreateParams.path`) : 1 024 octets, 20 segments. */
const PATH_MAX_BYTES = 1024
const SEGMENT_MAX_COUNT = 20
/**
 * Un segment devient un nom de fichier (APFS : 255 octets), qui reçoit parfois un suffixe : `.<uuid>.tmp`
 * (+41 octets) à l'écriture, `.recovered-<horodatage>` (~+35) pour une copie de secours. 200 laisse la place aux deux.
 */
const SEGMENT_MAX_BYTES = 200

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

/**
 * Caractères que l'API refuse : contrôle (Cc), format (Cf) et les séparateurs de ligne et de paragraphe
 * U+2028 et U+2029 (Zl, Zp). L'antislash s'y ajoute : sur un chemin de fichier, il ne désigne rien de sûr.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u

/**
 * Vrai pour un chemin de mémoire que l'API accepte et que le dossier de brouillons peut écrire sans
 * en sortir : il commence par `/`, compte 1 à 20 segments non vides (ni `.` ni `..`), reste en forme
 * NFC, sans caractère interdit, sur 1 024 octets au plus, et 200 octets au plus par segment.
 */
export function isSafeMemoryPath(path: string): boolean {
  if (!path.startsWith('/') || byteLength(path) > PATH_MAX_BYTES) {
    return false
  }
  if (path.normalize('NFC') !== path || FORBIDDEN.test(path)) {
    return false
  }
  const segments = path.slice(1).split('/')
  if (segments.length > SEGMENT_MAX_COUNT) {
    return false
  }
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && byteLength(segment) <= SEGMENT_MAX_BYTES)
}
