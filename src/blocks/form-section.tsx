// FormSection : les champs d'un formulaire sous un titre, une erreur éventuelle, et le pied Enregistrer / Annuler / Supprimer.
//
// Quand l'utiliser : un formulaire de création ou d'édition (profil, fournisseur), ouvert depuis une liste. Origine : agent-profiles
// (profile-form, provider-form). Les champs sont les enfants : le bloc pose le titre, l'erreur et le pied, pas les champs.
// Quand ne pas l'utiliser : pour un réglage qui s'applique à la frappe (un `Switch`, un `Select` seul), pas de pied ;
// pour un geste isolé avec son résultat, `ActionRow` ; pour confirmer une suppression en ligne, un bloc de confirmation.
//
// Pièges :
// - Le bloc ne déclare aucun atome : valeurs des champs, erreurs par champ et `busy` viennent de l'appelant (recette plus bas).
//   Les erreurs d'un champ vont dans son `Field error`, l'erreur du bloc (`error`) est celle du formulaire entier (« Save failed »).
// - Le titre est dessiné comme celui de `PanelHeader`, en `Text weight="semibold"` : un `Heading level={3}` est dessiné par Orca en petites
//   capitales grises (constaté en 1.4.269), une étiquette de section et non un titre.
// - L'alerte d'erreur porte toujours un titre (`errorTitle`, `Could not save` par défaut, y compris pour une chaîne vide) et `error` en est le corps : un `Callout` sans
//   titre est coiffé par Orca d'après son ton (constaté en 1.4.269 : « Tip » pour `success`, « Warning » pour `warning`, « Caution » pour `danger`).
// - Les boutons ne s'affichent que si on leur donne un `onSave`, `onCancel` ou `onRemove` : sans `onRemove`, pas de « Remove »
//   (création) ; sans `onCancel`, pas de « Cancel ». `onSave` est obligatoire.
// - `busy` désactive Save et Remove, jamais Cancel : on peut toujours sortir d'un geste qui traîne.
// - `error` vide (`''`) ou absent ne dessine rien : on peut passer `error={read(formError) ?? undefined}`.
// - Le pied passe à la ligne quand la largeur manque (220 px) plutôt que de couper un bouton.
// - Libellés des boutons et titre par `clipText` (16384 unités par texte) ; l'erreur aussi ; le titre de l'alerte par `clipLabel` (1 KiB).
// - Textes par défaut (`Save`, `Cancel`, `Remove`, `Could not save`) en anglais : à localiser par qui copie le fichier, ou à passer en `saveLabel`,
//   `cancelLabel`, `removeLabel`, `errorTitle`. Un libellé vide est un bug de l'appelant : aucun repli n'est posé, et Orca
//   ne signale rien pour un `Button` vide : `orca plugin check` ne peut pas le voir, le bouton est seulement blanc. Ne jamais en passer un.
// - Tout est une seule liste plate clée (`title`, `fields`, `error`, `footer`) : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants.
//   Le conteneur des champs n'existe que s'il y a des enfants.
//
// Ce que le bloc ne dit pas : les erreurs de plusieurs champs réunies en tête, un avertissement non bloquant (un `Callout warning`
// de plus au-dessus du pied : à poser dans les enfants), une taille de bouton autre que celle par défaut. Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 2 (`Callout`).
//
// Recette côté panneau, un atome pour le brouillon, un pour `busy`, un pour l'erreur du formulaire :
//   const draft = atom('draft', { name: '' })
//   const busy = atom('busy', false)
//   const formError = atom<string | null>('formError', null)
//   <FormSection title="Edit profile" busy={read(busy)} error={read(formError) ?? undefined} errorTitle="Could not save"
//     onSave={save} onCancel={close} onRemove={isNew ? undefined : remove}>
//     <Field label="Name" error={nameError}>
//       <Input label="Name" labelHidden value={read(draft).name} invalid={nameError !== undefined} onChange={(name) => set(draft, { name })} />
//     </Field>
//   </FormSection>
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `clip-label.ts` avec lui).
import { Button, Callout, Row, Stack, Text, type OrcaElement, type OrcaNode } from 'orca'
import { clipLabel, clipText } from './clip-label'

// Vrai quand les enfants ne dessinent rien : `null`, `undefined`, un booléen ou une liste vide (`{cond ? <Field /> : null}`).
function isEmptyNode(node: OrcaNode | undefined): boolean {
  if (node === undefined || node === null || typeof node === 'boolean') return true
  return Array.isArray(node) && node.every(isEmptyNode)
}

export function FormSection(props: {
  title?: string
  error?: string
  errorTitle?: string
  busy?: boolean
  saveLabel?: string
  onSave: () => void
  cancelLabel?: string
  onCancel?: () => void
  removeLabel?: string
  onRemove?: () => void
  children?: OrcaNode
}): OrcaElement {
  return (
    <Stack gap="md">
      {/* Une seule liste plate et entièrement clée : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants. */}
      {[
        props.title ? (
          <Text key="title" weight="semibold">
            {clipText(props.title)}
          </Text>
        ) : null,
        isEmptyNode(props.children) ? null : (
          <Stack key="fields" gap="md">
            {props.children}
          </Stack>
        ),
        props.error ? (
          <Callout key="error" tone="danger" title={clipLabel((props.errorTitle ?? '').trim()) || 'Could not save'}>
            {clipText(props.error)}
          </Callout>
        ) : null,
        <Row key="footer" justify="between" align="center" gap="sm" wrap>
          {[
            <Row key="primary" gap="xs">
              {[
                <Button key="save" disabled={props.busy} onPress={props.onSave}>
                  {clipText(props.saveLabel ?? 'Save')}
                </Button>,
                props.onCancel === undefined ? null : (
                  <Button key="cancel" variant="ghost" onPress={props.onCancel}>
                    {clipText(props.cancelLabel ?? 'Cancel')}
                  </Button>
                )
              ]}
            </Row>,
            props.onRemove === undefined ? null : (
              <Button key="remove" variant="outline" tone="danger" disabled={props.busy} onPress={props.onRemove}>
                {clipText(props.removeLabel ?? 'Remove')}
              </Button>
            )
          ]}
        </Row>
      ]}
    </Stack>
  )
}
