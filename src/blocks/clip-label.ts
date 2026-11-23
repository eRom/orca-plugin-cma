// Orca jette toute prop de libellé au-delà de 1024 unités UTF-16 : on coupe avant, avec marge.
const DEFAULT_LABEL_MAX_LENGTH = 1000
// Orca 1.4.269, mesuré : un texte enfant est refusé (rendu entier refusé) au-delà de 16384 unités UTF-16, pas de 16384 octets.
const DEFAULT_TEXT_MAX_LENGTH = 16000

// Coupe à `maxLength` unités UTF-16 au plus, finit par « … » si coupé, ne scinde jamais une paire de substitution.
function clipTo(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  let end = Math.max(0, maxLength - 1)
  const last = text.charCodeAt(end - 1)
  // Un demi-caractère haut en bout de coupe : on le retire avec sa paire absente.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

// Pour toute prop de libellé (`label`, `title`, `placeholder`, `description`) : 1000 unités par défaut.
export function clipLabel(text: string, maxLength: number = DEFAULT_LABEL_MAX_LENGTH): string {
  return clipTo(text, maxLength)
}

// Pour toute chaîne qui devient l'enfant d'un `Text` ou d'un `Button` : 16000 unités par défaut.
export function clipText(text: string, maxLength: number = DEFAULT_TEXT_MAX_LENGTH): string {
  return clipTo(text, maxLength)
}
