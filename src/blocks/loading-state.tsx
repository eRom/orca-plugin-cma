// LoadingState : l'attente d'un panneau, un squelette pour une liste qui charge, un spinner avec son texte pour une opération en cours.
//
// Quand l'utiliser : `list` à la place d'une liste ou d'un groupe pas encore reçu (premier chargement) ; `operation` pour un geste qui
// traîne (Installing…, Saving…). Origine : agent-profiles et agent-network (squelette de liste), agent-claude-managed (spinner de
// chargement), agent-skills (progression en ligne, panel-row).
// Quand ne pas l'utiliser : pour une progression chiffrée, prendre `Progress` ; pour un rafraîchissement d'une liste déjà affichée,
// garder la liste et griser l'action, un squelette ferait sauter l'écran ; pour une attente sans texte à dire, un `Spinner` seul.
//
// Pièges :
// - Le bloc ne déclare aucun atome : le drapeau de chargement vient de l'appelant, qui décide quand le bloc remplace la liste (recette plus bas).
// - `list` : le libellé n'est lu que par les lecteurs d'écran (le squelette est muet) ; `lines` vaut 3 par défaut et reste borné à 1 à 10,
//   plage constatée sur Orca 1.4.269 (hors plage Orca jette la prop avec un avertissement, et `NaN` fait refuser le rendu) : un nombre
//   hors plage ou décimal est ramené dans la plage, un nombre non fini retombe sur 3.
// - `operation` : le spinner est caché (`labelHidden`), son texte visible est le même libellé, en `Text muted size="xs"`, pour qu'un lecteur
//   d'écran et un voyant lisent la même chose. Garder une seule des deux pour l'état, jamais le squelette et le spinner ensemble.
// - Le libellé passe par `clipLabel` (1000 unités) pour le squelette et le spinner, par `clipText` (16000) pour le texte visible.
// - Un libellé vide est refusé par Orca pour un `Spinner` : repli `Loading`, texte en anglais, à localiser par qui copie le fichier.
//   Passer toujours un libellé qui dit ce qui charge (« Loading agents »).
//
// Ce que le bloc ne dit pas : un squelette de forme `block` ou `circle`, un spinner dont le texte visible diffère du nom accessible,
// une progression chiffrée, un nombre de lignes lié à la hauteur réelle de la liste. Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 2 (`Skeleton`).
//
// Recette côté panneau, un atome pour la liste (null tant qu'elle n'est pas reçue) et un drapeau pour l'opération :
//   const agents = atom<Agent[] | null>('agents', null)
//   const installing = atom(false)
//   {read(agents) === null ? <LoadingState kind="list" label="Loading agents" /> : <AgentList agents={read(agents)!} />}
//   {read(installing) ? <LoadingState kind="operation" label="Installing…" /> : null}
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `clip-label.ts` avec lui).
import { Row, Skeleton, Spinner, Text, type OrcaElement } from 'orca'
import { clipLabel, clipText } from './clip-label'

// Plage de `Skeleton.lines` constatée sur Orca 1.4.269 : 0 et 11 sont jetés avec un avertissement, 1 et 10 passent.
const MIN_LINES = 1
const MAX_LINES = 10
const DEFAULT_LINES = 3

function asLineCount(lines: number | undefined): number {
  if (lines === undefined || !Number.isFinite(lines)) return DEFAULT_LINES
  return Math.min(MAX_LINES, Math.max(MIN_LINES, Math.trunc(lines)))
}

export function LoadingState(
  props: { kind: 'list'; label: string; lines?: number } | { kind: 'operation'; label: string }
): OrcaElement {
  if (props.kind === 'list') {
    return <Skeleton shape="text" lines={asLineCount(props.lines)} label={clipLabel(props.label)} />
  }
  return (
    <Row gap="xs" align="center">
      <Spinner label={clipLabel(props.label.trim()) || 'Loading'} labelHidden />
      <Text muted size="xs">
        {clipText(props.label)}
      </Text>
    </Row>
  )
}
