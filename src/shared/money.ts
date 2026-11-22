import type { Money } from '../protocol'

/** Montant en unités mineures (`"2500"`) vers un affichage lisible : `$25.00`, ou `0.50 EUR` hors dollar. */
export function formatMoney(money: Money | null): string {
  if (money === null) return ''
  const minor = BigInt(money.minor)
  const whole = minor / 100n
  const cents = (minor % 100n).toString().padStart(2, '0')
  return money.currency === 'USD' ? `$${whole}.${cents}` : `${whole}.${cents} ${money.currency}`
}

/**
 * Dollars saisis (`"5"`, `"1,50"`, `" 12.3 "`) vers des unités mineures en chaîne.
 * Renvoie null pour une saisie invalide, négative, nulle ou plus précise que le centime.
 */
export function dollarsToMinor(input: string): string | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(',', '.'))
  if (match === null) return null
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  return minor > 0n ? minor.toString() : null
}

/** Somme exacte de montants en unités mineures (BigInt, jamais de flottant). */
export function sumMinor(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString()
}
