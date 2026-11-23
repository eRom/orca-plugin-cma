const UNITS = ['kB', 'MB', 'GB']

/**
 * Taille en puissances de 1000 avec une décimale (`9.4 kB`), comme l'API compte ses plafonds.
 * Une valeur qui s'arrondit à `1000.0` passe à l'unité suivante, jamais `1000.0 kB`.
 */
export function formatDecimalSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  let value = bytes / 1000
  let unit = 0
  while (unit < UNITS.length - 1 && Number(value.toFixed(1)) >= 1000) {
    value /= 1000
    unit += 1
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`
}
