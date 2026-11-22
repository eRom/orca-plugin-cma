import type { ClippedText } from '../protocol'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Vrai pour un octet de continuation UTF-8 (10xxxxxx) : jamais le début d'un caractère. */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

/**
 * Garde le début du texte dans la limite d'octets, en coupant sur une frontière de caractère UTF-8.
 * Aucun suffixe n'est ajouté : c'est l'interface qui affiche la troncature.
 */
export function clipBytes(text: string, maxBytes: number): ClippedText {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let end = Math.max(0, maxBytes)
  while (end > 0 && isContinuation(bytes[end])) end--
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true }
}

/** Comme `clipBytes`, mais garde la fin du texte (aperçus de messages en cours d'écriture). */
export function clipBytesEnd(text: string, maxBytes: number): ClippedText {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let start = bytes.length - Math.max(0, maxBytes)
  while (start < bytes.length && isContinuation(bytes[start])) start++
  return { text: decoder.decode(bytes.subarray(start)), truncated: true }
}
