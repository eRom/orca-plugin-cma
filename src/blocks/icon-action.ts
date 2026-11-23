// Types partagés des blocs : à copier avec eux, ils n'importent que `orca`.
import type { IconName, Tone } from 'orca'

// Une action en icône seule : le libellé sert de nom accessible et d'infobulle.
// `key` garde l'identité du contrôle quand une action voisine apparaît ou disparaît (sinon l'index sert de clé et le focus se perd).
// Deux `key` identiques dans une même liste sont à la charge de l'appelant : Orca refuse alors tout le rendu.
// `active` dit « basculée » : l'action est dessinée en `outline` (sinon `ghost`). Constaté sur le thème sombre : `tone: 'accent'` sur un
// bouton `ghost` est identique au neutre, la bascule serait invisible. `tone` reste libre et indépendant de `active`.
export type IconAction = {
  key?: string
  icon: IconName
  label: string
  onPress: () => void
  disabled?: boolean
  active?: boolean
  tone?: Tone
}

// Une action en bouton avec texte, pour les blocs qui en portent ; même règle pour `key`.
export type ButtonAction = {
  key?: string
  label: string
  onPress: () => void
  variant?: 'solid' | 'outline' | 'ghost'
  tone?: Tone
  icon?: IconName
  disabled?: boolean
}
