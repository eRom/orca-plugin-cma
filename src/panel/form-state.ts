// État des formulaires de configuration : la saisie en cours survit à un redémarrage du panneau
// (atome persisté), les secrets jamais. Une vue lit son formulaire par `readForm`, l'écrit par `editForm`
// (et un secret par `editSecret`).
import { atom, read, update } from 'orca'

/**
 * Le repère de version d'un objet : l'horodatage d'un environnement, le numéro de version d'un agent.
 * `null` pour une création.
 */
export type BaseStamp = string | number | null

/**
 * Une saisie gardée : le formulaire, la base (le formulaire de l'objet tel qu'il était à l'ouverture)
 * et le repère de version de cette base. Sans eux, une saisie rouverte après un changement ailleurs
 * serait comparée à la version fraîche : elle écraserait ce changement sans conflit, et enverrait
 * des champs que la personne n'a pas touchés.
 */
type Draft = {
  form: unknown
  base: unknown
  baseStamp: BaseStamp
  /** Vrai quand un secret a été tapé : le secret lui-même n'est jamais gardé, ce drapeau seul survit. */
  hadSecret?: boolean
}

/** Saisies gardées, par clé de formulaire (`kind:id`). Jamais de secret ici : il va dans `secretDrafts`. */
export const formDrafts = atom<Record<string, Draft>>('forms.drafts', {}, { persist: 'plugin' })

/** Secrets saisis, par clé de formulaire. Éphémère : jamais persisté, jamais journalisé. */
export const secretDrafts = atom<Record<string, string>>({})

/** Texte brut des champs multi-lignes, par formulaire et par champ (`key#field`) ; absent, il se déduit du formulaire. Éphémère. */
export const rawTexts = atom<Record<string, string>>({})

/** Champs que la personne a modifiés au moins une fois (`key#field`) : leur erreur peut alors s'afficher. Éphémère. */
export const touchedFields = atom<Record<string, true>>({})

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

/** Vrai pour une saisie à la forme courante ; les formes antérieures (le formulaire seul, ou sans base) n'en sont pas. */
function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    Object.hasOwn(candidate, 'form') &&
    Object.hasOwn(candidate, 'base') &&
    (candidate.baseStamp === null || typeof candidate.baseStamp === 'string' || typeof candidate.baseStamp === 'number')
  )
}

/**
 * Le formulaire à afficher : la saisie gardée si elle existe, sinon `freshBase`.
 * - `base` et `baseStamp` : ceux de la saisie si elle existe (la version sur laquelle elle a été commencée),
 *   sinon `freshBase` et `currentStamp`. C'est ce qu'il faut envoyer à l'écriture.
 * - `dirty` : le formulaire diffère de `base`.
 * - `stale` : la saisie a été commencée sur une autre version que `currentStamp` (null pour une création).
 * Une saisie gardée à une forme antérieure (sans base) est ignorée : elle compte comme absente.
 */
export function readForm<F>(
  key: string,
  freshBase: F,
  currentStamp: BaseStamp = null
): { form: F; base: F; baseStamp: BaseStamp; dirty: boolean; stale: boolean } {
  const drafts = read(formDrafts)
  const draft: unknown = Object.hasOwn(drafts, key) ? drafts[key] : undefined
  if (!isDraft(draft)) return { form: freshBase, base: freshBase, baseStamp: currentStamp, dirty: false, stale: false }
  const form = draft.form as F
  const base = draft.base as F
  return {
    form,
    base,
    baseStamp: draft.baseStamp,
    dirty: !deepEqual(form, base),
    stale: draft.baseStamp !== currentStamp
  }
}

/**
 * Garde la saisie en cours. `base` (le formulaire de l'objet chargé) et `baseStamp` (son repère de
 * version, null à la création) sont retenus à la première saisie d'une clé, puis conservés tant que la saisie vit.
 */
export function editForm<F>(key: string, form: F, base: F, baseStamp: BaseStamp = null): void {
  update(formDrafts, (drafts) => {
    const existing: unknown = Object.hasOwn(drafts, key) ? drafts[key] : undefined
    return {
      ...drafts,
      [key]: isDraft(existing)
        ? { form, base: existing.base, baseStamp: existing.baseStamp, ...(existing.hadSecret === true && { hadSecret: true }) }
        : { form, base, baseStamp }
    }
  })
}

/**
 * Garde un secret tapé, en mémoire seulement, et note dans la saisie qu'un secret a été tapé (la saisie
 * est créée au besoin, avec `form`, `base` et `baseStamp`). `''` retire le secret et le drapeau.
 */
export function editSecret<F>(key: string, secret: string, form: F, base: F, baseStamp: BaseStamp = null): void {
  update(secretDrafts, (secrets) => {
    const { [key]: _dropped, ...rest } = secrets
    return secret === '' ? rest : { ...rest, [key]: secret }
  })
  update(formDrafts, (drafts) => {
    const existing: unknown = Object.hasOwn(drafts, key) ? drafts[key] : undefined
    const kept: Draft = isDraft(existing) ? existing : { form, base, baseStamp }
    const { hadSecret: _previous, ...plain } = kept
    return { ...drafts, [key]: secret === '' ? plain : { ...plain, hadSecret: true } }
  })
}

/** Vrai quand un secret avait été tapé dans cette saisie et que le panneau l'a perdu (redémarrage) : il est à retaper. */
export function secretCleared(key: string): boolean {
  const drafts = read(formDrafts)
  const draft: unknown = Object.hasOwn(drafts, key) ? drafts[key] : undefined
  return isDraft(draft) && draft.hadSecret === true && (read(secretDrafts)[key] ?? '') === ''
}

const fieldKey = (key: string, field: string): string => `${key}#${field}`

/** Le texte brut d'un champ multi-ligne ; absent, `derived` (ce que le formulaire en dit). */
export function fieldText(key: string, field: string, derived: string): string {
  return read(rawTexts)[fieldKey(key, field)] ?? derived
}

export function setFieldText(key: string, field: string, text: string): void {
  update(rawTexts, (texts) => ({ ...texts, [fieldKey(key, field)]: text }))
}

export function dropFieldText(key: string, field: string): void {
  update(rawTexts, ({ [fieldKey(key, field)]: _dropped, ...rest }) => rest)
}

/** Note que la personne a modifié ce champ : son erreur peut s'afficher. */
export function touchField(key: string, field: string): void {
  if (read(touchedFields)[fieldKey(key, field)] !== true) update(touchedFields, (fields): Record<string, true> => ({ ...fields, [fieldKey(key, field)]: true }))
}

export function isTouched(key: string, field: string): boolean {
  return read(touchedFields)[fieldKey(key, field)] === true
}

/** Oublie toutes les saisies : celles d'un workspace visent des objets qui n'existent pas dans le suivant. */
export function clearAllForms(): void {
  update(formDrafts, () => ({}))
  update(secretDrafts, () => ({}))
  update(formConflict, () => ({}))
  update(rawTexts, () => ({}))
  update(touchedFields, () => ({}))
}

/** Oublie la saisie, le secret, le conflit, les textes bruts et les champs touchés de ce formulaire. */
export function clearForm(key: string): void {
  const without = <V>(record: Record<string, V>): Record<string, V> => {
    const { [key]: _dropped, ...rest } = record
    return rest
  }
  const withoutFields = <V>(record: Record<string, V>): Record<string, V> =>
    Object.fromEntries(Object.entries(record).filter(([name]) => !name.startsWith(`${key}#`)))
  update(formDrafts, without)
  update(secretDrafts, without)
  update(formConflict, without)
  update(rawTexts, withoutFields)
  update(touchedFields, withoutFields)
}
