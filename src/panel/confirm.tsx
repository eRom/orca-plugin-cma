// Confirmation en deux temps : un premier appui ouvre la question, le second exécute l'action.
import { atom, Button, Callout, read, Row, set, Stack, Text, update } from 'orca'
import { ConfirmInline } from '../blocks/confirm-inline'
import { clipBytes } from '../shared/text'
import { run } from './state'

/** Longueur maximale, en octets, d'un nom repris dans une question. */
const NAME_LIMIT_BYTES = 200

/** Clé de la confirmation ouverte ; une seule à la fois. Éphémère. */
const pendingConfirmation = atom<string | null>(null)

/** Clés des confirmations dont l'action est en route : leur bouton est désactivé. */
const runningConfirmations = atom<string[]>([])

export function archiveQuestion(name: string): string {
  return `Archive ${clipBytes(name, NAME_LIMIT_BYTES).text}? This can't be undone.`
}

export function deleteQuestion(name: string): string {
  return `Delete ${clipBytes(name, NAME_LIMIT_BYTES).text} for good? This can't be undone.`
}

type ConfirmActionProps = {
  actionKey: string
  label: string
  question: string
  confirmLabel: string
  onConfirm: () => Promise<void>
  disabled?: boolean
}

/** Exécute l'action, ferme la question à la réussite ; en cas d'échec elle reste ouverte et l'avis s'affiche. */
async function confirmAction(actionKey: string, onConfirm: () => Promise<void>): Promise<void> {
  if (read(runningConfirmations).includes(actionKey)) return
  update(runningConfirmations, (keys) => [...keys, actionKey])
  try {
    await onConfirm()
    if (read(pendingConfirmation) === actionKey) set(pendingConfirmation, null)
  } finally {
    update(runningConfirmations, (keys) => keys.filter((key) => key !== actionKey))
  }
}

export function ConfirmAction({ actionKey, label, question, confirmLabel, onConfirm, disabled }: ConfirmActionProps) {
  if (read(pendingConfirmation) !== actionKey) {
    return (
      <Button
        variant="ghost"
        tone="danger"
        size="sm"
        disabled={disabled}
        onPress={() => set(pendingConfirmation, actionKey)}
      >
        {label}
      </Button>
    )
  }
  const running = read(runningConfirmations).includes(actionKey)
  return (
    <Callout tone="warning">
      <Stack gap="sm">
        <Text>{question}</Text>
        <Row gap="sm" wrap>
          <Button variant="ghost" size="sm" onPress={() => set(pendingConfirmation, null)}>
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="danger"
            size="sm"
            disabled={disabled || running}
            onPress={() => run(() => confirmAction(actionKey, onConfirm))}
          >
            {confirmLabel}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

/** Ouvre la question de `actionKey` : le geste (un bouton d'une rangée d'actions) ne dessine pas lui-même sa confirmation. */
export function askConfirmation(actionKey: string): void {
  set(pendingConfirmation, actionKey)
}

/**
 * La confirmation d'un geste lancé ailleurs (`askConfirmation`) : le bloc `ConfirmInline`, avec la même logique que
 * `ConfirmAction` (une seule question à la fois, bouton grisé en route, refus de l'API remonté, question laissée ouverte).
 */
export function ConfirmPanel({ actionKey, question, confirmLabel, onConfirm, disabled }: Omit<ConfirmActionProps, 'label'>) {
  if (read(pendingConfirmation) !== actionKey) return null
  const running = read(runningConfirmations).includes(actionKey)
  return (
    <ConfirmInline
      question={question}
      confirmLabel={confirmLabel}
      onCancel={() => set(pendingConfirmation, null)}
      onConfirm={() => {
        if (disabled || running) return
        run(() => confirmAction(actionKey, onConfirm))
      }}
    />
  )
}
