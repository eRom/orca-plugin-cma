import { THREAD_WINDOW_BYTES, THREAD_WINDOW_ROWS, type ThreadRow } from '../protocol'

const encoder = new TextEncoder()

/** Poids d'une ligne dans le budget d'octets du panneau : sa taille JSON en UTF-8. */
export function rowBytes(row: ThreadRow): number {
  return encoder.encode(JSON.stringify(row)).length
}

/**
 * Fenêtre de lignes rendue : remonte depuis `pageEnd` (exclusif, `null` = la fin) jusqu'au premier
 * plafond atteint (lignes ou octets), en gardant toujours au moins une ligne.
 */
export function pageWindow(
  rows: readonly ThreadRow[],
  pageEnd: number | null,
  limits: { maxRows?: number; maxBytes?: number } = {},
): { visible: ThreadRow[]; firstIndex: number } {
  const maxRows = limits.maxRows ?? THREAD_WINDOW_ROWS
  const maxBytes = limits.maxBytes ?? THREAD_WINDOW_BYTES
  const end = Math.min(pageEnd ?? rows.length, rows.length)
  let firstIndex = end
  let bytes = 0
  while (firstIndex > 0 && end - firstIndex < maxRows) {
    const next = bytes + rowBytes(rows[firstIndex - 1])
    if (next > maxBytes && firstIndex < end) break
    bytes = next
    firstIndex--
  }
  return { visible: rows.slice(firstIndex, end), firstIndex }
}
