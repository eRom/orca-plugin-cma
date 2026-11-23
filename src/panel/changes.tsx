// Aperçu des changements d'une écriture en attente : une ligne par champ, puis Confirm et Cancel.
// Le worker a déjà plafonné la liste (`CHANGES_RENDER_CAP`) et abrégé chaque valeur ; le panneau
// recoupe quand même chaque libellé : Orca refuse tout le rendu au-delà de 1 Kio par libellé.
import { Button, List, ListItem, Row, Stack, Text, type OrcaNode } from 'orca'
import type { FieldChange, PreparedWrite } from '../protocol'
import { clipBytes } from '../shared/text'

/** Plafond d'un chemin repris en titre, et d'une valeur avant ou après : `avant → après` reste sous 1 Kio. */
const PATH_LIMIT_BYTES = 300
const VALUE_LIMIT_BYTES = 200

/** Texte d'un changement sans valeur ni avant ni après (ne devrait pas arriver, mais reste lisible). */
const ABSENT = '(not set)'

/** Coupe sur une frontière de caractère et signale la coupe par `…`. */
function clipLabel(text: string, maxBytes: number): string {
  const clipped = clipBytes(text, maxBytes)
  return clipped.truncated ? `${clipped.text}…` : clipped.text
}

/**
 * La description d'une ligne : les lignes ajoutées et retirées d'un texte long, sinon `avant → après`.
 * Un texte long qui ne change que d'ordre ou d'espaces (`+0 / −0`) ne dirait rien : il montre `avant → après`.
 */
export function describeChange(change: FieldChange): string {
  const { lines } = change
  if (lines !== null && (lines.added > 0 || lines.removed > 0)) {
    return `+${lines.added} / −${lines.removed} lines`
  }
  if (change.before === null) {
    return change.after === null ? ABSENT : `Added: ${clipLabel(change.after, VALUE_LIMIT_BYTES)}`
  }
  if (change.after === null) {
    return `Removed: ${clipLabel(change.before, VALUE_LIMIT_BYTES)}`
  }
  return `${clipLabel(change.before, VALUE_LIMIT_BYTES)} → ${clipLabel(change.after, VALUE_LIMIT_BYTES)}`
}

type ChangesPreviewProps = {
  prepared: PreparedWrite
  /** Vrai pendant l'envoi : Confirm et Cancel sont grisés, un second appui ne part pas. */
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ChangesPreview({ prepared, busy, onConfirm, onCancel }: ChangesPreviewProps): OrcaNode {
  const { changes, totalChanges } = prepared
  return (
    <Stack gap="sm">
      <Text weight="semibold">Review changes</Text>
      {changes.length === 0 ? (
        <Text muted size="sm">
          No field changes.
        </Text>
      ) : (
        <List label="Changes">
          {changes.map((change, index) => (
            <ListItem key={String(index)} title={clipLabel(change.path, PATH_LIMIT_BYTES)} description={describeChange(change)} />
          ))}
        </List>
      )}
      {totalChanges > changes.length ? (
        <Text muted size="sm">{`Showing the first ${changes.length} of ${totalChanges} changes.`}</Text>
      ) : null}
      <Row gap="sm" wrap>
        <Button variant="ghost" size="sm" disabled={busy} onPress={onCancel}>
          Cancel
        </Button>
        <Button variant="solid" tone="accent" size="sm" disabled={busy} onPress={onConfirm}>
          Confirm
        </Button>
      </Row>
    </Stack>
  )
}
