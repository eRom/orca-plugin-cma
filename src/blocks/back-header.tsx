// BackHeader : l'en-tête d'un écran secondaire, un bouton de retour, un titre, un sous-titre et un coin libre.
//
// Quand l'utiliser : en haut d'une vue de détail ou d'un formulaire ouvert depuis une liste. Origine : agent-claude-managed,
// trois copies de ce même en-tête (session-view, config-views, new-session).
// Quand ne pas l'utiliser : pour la racine d'un panneau, prendre PanelHeader (rien à quitter).
//
// Pièges :
// - Le catalogue n'a pas d'icône de retour : le bouton est un `Button` ghost de texte `‹ Back` (le libellé se change par `backLabel`).
// - `trailing` est libre (un `Badge`, un `Button`) ; la rangée passe à la ligne quand la largeur manque, plutôt que de couper.
// - Le titre passe à la ligne au lieu d'être tronqué ; `clipText` le borne, car Orca refuse tout le rendu au-delà de 16384 unités par texte.
// - Le texte par défaut du retour (`Back`) est en anglais : à localiser par qui copie le fichier, ou à passer en `backLabel`.
// - Sans sous-titre ni `trailing`, aucun conteneur vide n'est dessiné.
// - Le texte du bouton de retour commence environ 10 px à droite du titre, à cause du rembourrage propre au bouton `ghost` (vu sur les
//   planches du 22/11 à 360 et à 220 px). Le propriétaire l'a gardé tel quel le 22/11 (choix a, contre un `Link` ou un `IconButton` à chevron).
//
// Catalogue minimal : 1 (`Stack`, `Row`, `Text`, `Button`).
//
// Panneau : le bloc ne déclare aucun atome ; la navigation (quelle vue est ouverte) appartient à l'appelant :
//   const view = atom<'list' | 'detail'>('view', 'list', { persist: 'plugin' })
//   <BackHeader title="Session" subtitle="sess_1" onBack={() => set(view, 'list')} trailing={<Badge tone="success">idle</Badge>} />
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `clip-label.ts` avec lui).
import { Button, Row, Stack, Text, type OrcaElement, type OrcaNode } from 'orca'
import { clipText } from './clip-label'

export function BackHeader(props: {
  title: string
  subtitle?: string
  backLabel?: string
  onBack: () => void
  trailing?: OrcaNode
}): OrcaElement {
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" justify="between" wrap>
        <Button variant="ghost" size="sm" onPress={props.onBack}>
          {`‹ ${clipText(props.backLabel ?? 'Back')}`}
        </Button>
        {props.trailing}
      </Row>
      <Stack gap="xs">
        <Text weight="semibold">{clipText(props.title)}</Text>
        {props.subtitle ? (
          <Text muted size="sm">
            {clipText(props.subtitle)}
          </Text>
        ) : null}
      </Stack>
    </Stack>
  )
}
