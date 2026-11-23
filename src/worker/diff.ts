// Différences champ par champ entre deux documents JSON : le récapitulatif montré avant une écriture.
import type { FieldChange } from '../protocol'
import { clipBytes } from '../shared/text'

/** Taille maximale, en octets, d'une valeur montrée dans un changement. */
const VALUE_MAX_BYTES = 200
const ELLIPSIS = '…'

type Plain = Record<string, unknown>

const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Un champ `undefined` vaut une clé absente : le JSON ne le porte pas. */
const definedKeys = (value: Plain): string[] => Object.keys(value).filter((key) => value[key] !== undefined)

/** Une chaîne telle quelle, tout le reste en JSON. */
const render = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'))

/** Abrège à `VALUE_MAX_BYTES` octets au plus, sur une frontière de caractère, avec un `…` quand ça coupe. */
export function abbreviate(text: string): string {
  const clipped = clipBytes(text, VALUE_MAX_BYTES - Buffer.byteLength(ELLIPSIS))
  return clipped.truncated ? `${clipped.text}${ELLIPSIS}` : text
}

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/** Compare deux textes comme des multiensembles de lignes : l'ordre des lignes ne compte pas. */
export function summarizeLines(before: string, after: string): { added: number; removed: number } {
  const remaining = new Map<string, number>()
  for (const line of linesOf(before)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1)
  }
  let added = 0
  for (const line of linesOf(after)) {
    const count = remaining.get(line) ?? 0
    if (count > 0) {
      remaining.set(line, count - 1)
    } else {
      added++
    }
  }
  let removed = 0
  for (const count of remaining.values()) {
    removed += count
  }
  return { added, removed }
}

const isLongText = (text: string): boolean => text.includes('\n') || Buffer.byteLength(text) > VALUE_MAX_BYTES

function leafChange(path: string, before: unknown, after: unknown): FieldChange {
  const lines =
    typeof before === 'string' && typeof after === 'string' && (isLongText(before) || isLongText(after))
      ? summarizeLines(before, after)
      : null
  return { path, before: abbreviate(render(before)), after: abbreviate(render(after)), lines }
}

/** Un sous-arbre présent d'un seul côté : une ligne, sa valeur en JSON, sans descendre dedans. */
const onlyBefore = (path: string, before: unknown): FieldChange => ({ path, before: abbreviate(render(before)), after: null, lines: null })
const onlyAfter = (path: string, after: unknown): FieldChange => ({ path, before: null, after: abbreviate(render(after)), lines: null })

function walk(path: string, before: unknown, after: unknown, out: FieldChange[]): void {
  if (isPlain(before) && isPlain(after)) {
    const afterKeys = definedKeys(after)
    const beforeKeys = new Set(definedKeys(before))
    for (const key of afterKeys) {
      const child = path === '' ? key : `${path}.${key}`
      if (beforeKeys.has(key)) {
        walk(child, before[key], after[key], out)
      } else {
        out.push(onlyAfter(child, after[key]))
      }
    }
    const kept = new Set(afterKeys)
    for (const key of beforeKeys) {
      if (!kept.has(key)) {
        out.push(onlyBefore(path === '' ? key : `${path}.${key}`, before[key]))
      }
    }
    return
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.max(before.length, after.length); index++) {
      const child = `${path}[${index}]`
      if (index >= before.length) {
        out.push(onlyAfter(child, after[index]))
      } else if (index >= after.length) {
        out.push(onlyBefore(child, before[index]))
      } else {
        walk(child, before[index], after[index], out)
      }
    }
    return
  }
  if (typeof before === typeof after && render(before) === render(after)) {
    return
  }
  out.push(leafChange(path, before, after))
}

/**
 * Les champs qui diffèrent. Les objets se parcourent par clé (dans l'ordre de `after`, puis les clés
 * retirées), les tableaux par index. Un sous-arbre qui n'existe que d'un côté donne une seule ligne.
 */
export function diffDocuments(before: unknown, after: unknown): FieldChange[] {
  const out: FieldChange[] = []
  walk('', before, after, out)
  return out
}
