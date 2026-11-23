// Règles pures d'un formulaire d'environnement, lues par le panneau (avant l'envoi) et par le worker
// (avant l'appel à l'API). Aucun import du SDK ici : le panneau ne peut charger que `orca` et des fichiers relatifs.
import { ALLOWED_HOSTS_MAX, PACKAGE_MANAGERS, type EnvironmentForm } from '../protocol'

/** Les entrées utiles d'une liste saisie à la main : coupées, sans ligne vide. */
export function cleaned(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== '')
}

export const METADATA_LINE_MESSAGE = 'Metadata lines must look like key=value.'

/**
 * Le défaut du texte brut des métadonnées (une paire `key=value` par ligne), ou null s'il est bon.
 * Une ligne sans `=` ou à clé vide est refusée : l'API lirait une valeur vide comme la suppression de la clé.
 */
export function metadataTextProblem(text: string): string | null {
  const wellFormed = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .every((line) => {
      const at = line.indexOf('=')
      return at !== -1 && line.slice(0, at).trim() !== ''
    })
  return wellFormed ? null : METADATA_LINE_MESSAGE
}

export const PACKAGE_LINE_MESSAGE = `Package lines must look like "pip requests" (${PACKAGE_MANAGERS.join(', ')}).`

/** Une ligne de paquet : le gestionnaire, une espace, le paquet ; null si elle n'a pas cette forme. */
export function parsePackageLine(line: string): { manager: (typeof PACKAGE_MANAGERS)[number]; name: string } | null {
  const match = /^(\S+)\s+(.+)$/.exec(line.trim())
  const manager = PACKAGE_MANAGERS.find((candidate) => candidate === match?.[1])
  return match && manager ? { manager, name: match[2]!.trim() } : null
}

/** Le défaut du texte brut des paquets (`<gestionnaire> <paquet>` par ligne), ou null s'il est bon. */
export function packagesTextProblem(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.every((line) => parsePackageLine(line) !== null) ? null : PACKAGE_LINE_MESSAGE
}

/** Le premier défaut du formulaire en texte lisible, ou null s'il peut partir. */
export function validateEnvironmentForm(form: EnvironmentForm): string | null {
  if (form.name.trim() === '') {
    return 'A name is required.'
  }
  // Une paire sans clé ne peut pas partir : `toRecord` l'écarterait en silence.
  if (form.metadata.some((item) => item.key.trim() === '')) {
    return METADATA_LINE_MESSAGE
  }
  // `self_hosted` : l'hôte gère le réseau et les paquets, rien à contrôler ici.
  if (form.hosting === 'self_hosted' || form.network.mode !== 'limited') {
    return null
  }
  if (cleaned(form.network.allowedHosts).length > ALLOWED_HOSTS_MAX) {
    return `At most ${ALLOWED_HOSTS_MAX} allowed hosts.`
  }
  if (!form.network.allowPackageManagers && PACKAGE_MANAGERS.some((manager) => cleaned(form.packages[manager]).length > 0)) {
    return "Package installs need 'Allow package managers' in a limited network."
  }
  return null
}
