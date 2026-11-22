// État des formulaires de configuration : la saisie en cours survit à un redémarrage du panneau
// (atome persisté), les secrets jamais. Une vue lit son formulaire par `readForm`, l'écrit par `editForm`.
import { atom, read, update } from 'orca'

/**
 * Une saisie gardée : le formulaire et l'horodatage de l'objet sur lequel elle a été commencée.
 * Sans lui, une saisie rouverte après un changement ailleurs serait comparée à la version fraîche
 * et écraserait ce changement sans conflit.
 */
type Draft = { form: unknown; baseUpdatedAt: string | null }

/** Saisies gardées, par clé de formulaire (`kind:id`). Jamais de secret ici : il va dans `secretDrafts`. */
export const formDrafts = atom<Record<string, Draft>>('forms.drafts', {}, { persist: 'plugin' })

/** Secrets saisis, par clé de formulaire. Éphémère : jamais persisté, jamais journalisé. */
export const secretDrafts = atom<Record<string, string>>({})

/** Formulaires dont l'objet a changé côté API depuis l'ouverture de la saisie. */
export const formConflict = atom<Record<string, boolean>>({})

/** Clé d'une saisie : le genre d'objet et son id, ou `new` pour une création. */
export function formKey(kind: string, id: string | null): string {
  return `${kind}:${id ?? 'new'}`
}

/** Égalité profonde de valeurs JSON (objets, tableaux, scalaires). */
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
  )
}

/** Vrai pour une saisie à la forme courante ; l'ancienne forme (le formulaire seul) n'en est pas une. */
function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    Object.hasOwn(candidate, 'form') &&
    (candidate.baseUpdatedAt === null || typeof candidate.baseUpdatedAt === 'string')
  )
}

/**
 * Le formulaire à afficher : la saisie gardée si elle existe, sinon `base`.
 * - `dirty` : elle diffère de `base`.
 * - `baseUpdatedAt` : l'horodatage à envoyer à l'écriture, celui de la saisie si elle existe, sinon `currentUpdatedAt`.
 * - `stale` : la saisie a été commencée sur une autre version que `currentUpdatedAt` (null pour une création).
 * Une saisie gardée à l'ancienne forme (sans horodatage) est ignorée : elle compte comme absente.
 */
export function readForm<F>(
  key: string,
  base: F,
  currentUpdatedAt: string | null = null
): { form: F; dirty: boolean; baseUpdatedAt: string | null; stale: boolean } {
  const drafts = read(formDrafts)
  const draft: unknown = Object.hasOwn(drafts, key) ? drafts[key] : undefined
  if (!isDraft(draft)) return { form: base, dirty: false, baseUpdatedAt: currentUpdatedAt, stale: false }
  const form = draft.form as F
  return {
    form,
    dirty: !deepEqual(form, base),
    baseUpdatedAt: draft.baseUpdatedAt,
    stale: draft.baseUpdatedAt !== currentUpdatedAt
  }
}

/**
 * Garde la saisie en cours. `baseUpdatedAt` est l'horodatage de l'objet chargé (null à la création) :
 * il est retenu à la première saisie d'une clé, puis conservé tant que la saisie vit.
 */
export function editForm<F>(key: string, form: F, baseUpdatedAt: string | null = null): void {
  update(formDrafts, (drafts) => {
    const existing: unknown = Object.hasOwn(drafts, key) ? drafts[key] : undefined
    return { ...drafts, [key]: { form, baseUpdatedAt: isDraft(existing) ? existing.baseUpdatedAt : baseUpdatedAt } }
  })
}

/** Oublie la saisie, le secret et le conflit de ce formulaire. */
export function clearForm(key: string): void {
  const without = <V>(record: Record<string, V>): Record<string, V> => {
    const { [key]: _dropped, ...rest } = record
    return rest
  }
  update(formDrafts, without)
  update(secretDrafts, without)
  update(formConflict, without)
}
