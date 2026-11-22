// Règles pures d'un formulaire d'environnement, lues par le panneau (avant l'envoi) et par le worker
// (avant l'appel à l'API). Aucun import du SDK ici : le panneau ne peut charger que `orca` et des fichiers relatifs.
import { ALLOWED_HOSTS_MAX, PACKAGE_MANAGERS, type EnvironmentForm } from '../protocol'

/** Les entrées utiles d'une liste saisie à la main : coupées, sans ligne vide. */
export function cleaned(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== '')
}

/** Le premier défaut du formulaire en texte lisible, ou null s'il peut partir. */
export function validateEnvironmentForm(form: EnvironmentForm): string | null {
  if (form.name.trim() === '') {
    return 'A name is required.'
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
