// ConfirmInline : la confirmation d'un geste destructif ou lourd, en ligne sous l'élément concerné, en alerte avec Annuler puis Confirmer.
//
// Quand l'utiliser : un geste qu'on ne défait pas (supprimer une compétence, remplacer un dossier) : le premier clic ouvre ce bloc à
// la place du geste, le second confirme. Origine : agent-skills (suppression d'une ligne dans une alerte `danger`, remplacement dans une
// alerte `warning`), agent-claude-managed (oublier une clé, qui y échange deux boutons en place).
// Quand ne pas l'utiliser : pour un geste qu'on défait d'un clic, pas de confirmation ; pour un formulaire entier, le pied de `FormSection` ;
// pour confirmer une action qui ne tient pas dans la largeur d'une rangée (un choix entre trois options), une `Callout` sur mesure.
//
// Pièges :
// - Le bloc ne déclare aucun atome : « confirmation en cours » appartient à l'appelant, qui l'ouvre au premier clic et le referme dans
//   `onCancel` comme dans `onConfirm` (recette plus bas). Une confirmation par ligne : l'atome retient l'identifiant de la ligne, pas un booléen.
// - Le ton se dit une fois (`danger` par défaut, `warning` pour un remplacement) et colore l'alerte. Le bouton de confirmation ne prend le ton
//   que pour `danger` : sur `warning` il garde le ton par défaut, comme dans agent-skills, car un bouton plein de ton `warning` se lit comme
//   une alarme que ce remplacement n'est pas. Le bouton Annuler est toujours en `outline`, posé avant Confirmer (le geste lourd reste à droite).
// - La question est le titre de l'alerte (`Callout title`), jamais Orca qui le choisit : un `Callout` sans titre est coiffé d'après son ton
//   (constaté en 1.4.269 : « Tip » pour `success`, « Warning » pour `warning`, « Caution » pour `danger`). Une phrase courte qui nomme
//   l'objet (« Remove "pdf-reader"? ») ; `clipLabel` la borne à 1000 unités (un titre est un libellé, plafonné à 1 KiB par Orca). Le corps ne tient que les deux boutons.
//   Une question vide est un bug de l'appelant : le bloc pose le repli `Are you sure?` (en anglais, à localiser), jamais le titre d'Orca.
// - Les textes par défaut (`Cancel`) sont en anglais : à localiser par qui copie le fichier, ou à passer en `cancelLabel`. `confirmLabel` est
//   obligatoire et doit dire le geste (« Remove »), pas « OK ». Un libellé vide est un bug de l'appelant : aucun repli n'est posé, et Orca ne
//   signale rien pour un `Button` vide, `orca plugin check` ne peut pas le voir, le bouton est seulement blanc. Ne jamais en passer un.
// - L'arbre est constant (alerte titrée, rangée de deux boutons) : le bloc ne change pas de forme, il apparaît ou disparaît en entier.
//
// Ce que le bloc ne dit pas : l'échange de boutons en place sans question ni alerte (agent-claude-managed, le bouton « Forget key » devient
// « Confirm » et « Cancel » dans la même rangée), un geste qui demande une saisie pour être confirmé (retaper le nom), une confirmation
// qui garde l'élément visible et grisé. Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 2 (`Callout`).
//
// Recette côté panneau, un atome qui retient la ligne à confirmer :
//   const confirming = atom<string | null>('confirming', null)
//   <Button variant="ghost" tone="danger" size="sm" onPress={() => set(confirming, skill.id)}>Remove</Button>
//   {read(confirming) === skill.id
//     ? <ConfirmInline question={`Remove "${skill.name}"?`} confirmLabel="Remove" onCancel={() => set(confirming, null)}
//         onConfirm={() => { set(confirming, null); removeSkill(skill) }} />
//     : null}
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `clip-label.ts` avec lui).
import { Button, Callout, Row, type OrcaElement } from 'orca'
import { clipLabel, clipText } from './clip-label'

export function ConfirmInline(props: {
  question: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'warning'
  onConfirm: () => void
  onCancel: () => void
}): OrcaElement {
  const tone = props.tone ?? 'danger'
  return (
    <Callout tone={tone} title={clipLabel(props.question.trim()) || 'Are you sure?'}>
      <Row gap="sm">
        <Button variant="outline" size="sm" onPress={props.onCancel}>
          {clipText(props.cancelLabel ?? 'Cancel')}
        </Button>
        <Button size="sm" tone={tone === 'danger' ? 'danger' : undefined} onPress={props.onConfirm}>
          {clipText(props.confirmLabel)}
        </Button>
      </Row>
    </Callout>
  )
}
