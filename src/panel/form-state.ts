// État des formulaires de configuration : la saisie en cours survit à un redémarrage du panneau
// (atome persisté), les secrets jamais. Une vue lit son formulaire par `readForm`, l'écrit par `editForm`.
import { atom, read, update } from 'orca'

/** Saisies gardées, par clé de formulaire (`kind:id`). Jamais de secret ici : il va dans `secretDrafts`. */
export const formDrafts = atom<Record<string, unknown>>('forms.drafts', {}, { persist: 'plugin' })

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

/** Le formulaire à afficher : la saisie gardée si elle existe, sinon `base`. `dirty` : elle diffère de `base`. */
export function readForm<F>(key: string, base: F): { form: F; dirty: boolean } {
  const drafts = read(formDrafts)
  if (!Object.hasOwn(drafts, key)) return { form: base, dirty: false }
  const form = drafts[key] as F
  return { form, dirty: !deepEqual(form, base) }
}

/** Garde la saisie en cours. */
export function editForm<F>(key: string, form: F): void {
  update(formDrafts, (drafts) => ({ ...drafts, [key]: form }))
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
