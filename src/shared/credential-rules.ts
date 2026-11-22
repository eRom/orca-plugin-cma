// Règles pures d'un formulaire d'identifiant, lues par le panneau (avant l'envoi) et par le worker
// (avant l'appel à l'API). Aucun import du SDK ici : le panneau ne peut charger que `orca` et des fichiers relatifs.
import { ALLOWED_HOSTS_MAX, type CredentialForm } from '../protocol'
import { cleaned } from './environment-rules'

/**
 * Le premier défaut du formulaire en texte lisible, ou null s'il peut partir. À la création le secret
 * est obligatoire ; à la modification un secret vide veut dire « inchangé ».
 */
export function validateCredentialForm(form: CredentialForm, creating: boolean): string | null {
  if (form.type === 'static_bearer') {
    if (form.mcpServerUrl.trim() === '') {
      return 'Enter the MCP server URL.'
    }
    return creating && form.token.trim() === '' ? 'Enter the token.' : null
  }
  if (form.secretName.trim() === '') {
    return 'Enter the variable name.'
  }
  if (creating && form.secretValue.trim() === '') {
    return 'Enter the value.'
  }
  if (form.network.mode === 'limited' && cleaned(form.network.allowedHosts).length > ALLOWED_HOSTS_MAX) {
    return `At most ${ALLOWED_HOSTS_MAX} allowed hosts.`
  }
  // L'API exige au moins un emplacement d'injection.
  if (!form.injection.header && !form.injection.body) {
    return 'Inject the value in a header, the body, or both.'
  }
  return null
}
