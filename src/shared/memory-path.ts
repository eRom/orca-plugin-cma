// Le chemin d'une mémoire : la règle vit ici pour que le panneau la lise avant tout envoi et que le
// worker la rejoue avant d'écrire un fichier. Fichier pur : aucun import, aucun accès au disque.

export const INVALID_MEMORY_PATH = 'A memory path starts with / and has no . or .. segments.'

/** Plafonds de l'API (`MemoryCreateParams.path`) : 1 024 octets, 20 segments. */
const PATH_MAX_BYTES = 1024
const SEGMENT_MAX_COUNT = 20
/**
 * Un segment devient un nom de fichier (APFS : 255 octets), qui reçoit parfois un suffixe : `.<uuid>.tmp`
 * (+41 octets) quand le brouillon est écrit par un fichier temporaire, ou `.recovered-<horodatage>` (~+35)
 * pour une copie de secours, que le worker écrit directement, sans fichier temporaire. Les deux suffixes ne
 * s'additionnent donc jamais ; 200 octets laissent la place au plus long.
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

/**
 * Deux chemins se recouvrent quand ils sont égaux ou que l'un est l'ancêtre de l'autre (`/notes` et
 * `/notes/todo.md`) : l'API refuse alors le second (409 `memory_path_conflict_error`). Insensible à la casse.
 */
export function overlaps(first: string, second: string): boolean {
  const p = first.toLowerCase()
  const q = second.toLowerCase()
  return p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)
}

/** Le refus d'un chemin déjà pris dans la banque ou dans une autre ligne : le même texte des deux côtés. */
export const MEMORY_PATH_TAKEN = 'A memory already has this path.'
