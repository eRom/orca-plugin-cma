// ErrorRetry : l'échec d'un chargement, en alerte avec un bouton Réessayer, ou en simple ligne grise quand la liste reste affichée.
//
// Quand l'utiliser : `error` quand rien n'a pu être chargé et que le panneau n'a rien d'autre à montrer ; `stale` quand une relecture
// échoue alors que la dernière liste reste à l'écran (« Showing the last known agents. »). Origine : agent-claude-managed et
// agent-profiles (alerte avec Réessayer), agent-network (ligne `stale` avec Réessayer en `ghost`).
// Quand ne pas l'utiliser : pour le résultat d'un geste (Installer, Enregistrer), prendre le retour d'`ActionRow` ou l'erreur de
// `FormSection` ; pour une confirmation, `ConfirmInline` ; pour un chargement, `LoadingState`.
//
// Pièges :
// - Le bloc ne déclare aucun atome : l'erreur vient de l'appelant, qui la vide quand `onRetry` relance le chargement (recette plus bas).
// - `error` : le titre est le libellé de l'`Callout` ; le détail (`message`) va en enfant `Text size="sm"`, jamais dans le titre, car
//   un libellé est plafonné à 1 KiB par Orca et un enfant `Text` à 16384 unités. Le titre est toujours dit : un `Callout` sans titre est coiffé
//   par Orca d'après son ton (constaté en 1.4.269 : « Tip » pour `success`, « Warning » pour `warning`, « Caution » pour `danger`). Un titre
//   vide est un bug de l'appelant : Orca refuse un libellé vide, le bloc pose donc un repli (`Something went wrong`) et Orca n'imprime jamais son propre
//   titre (« Caution »). Ce repli est en anglais : à localiser par qui copie le fichier.
// - Le bouton n'est dessiné que si `onRetry` est donné : sans lui l'alerte est une simple information, sans bouton blanc ni inerte.
//   Il est en `outline sm` (la variante `solid` est réservée au geste principal du panneau).
// - `stale` : une ligne sans cadre d'alerte, le bouton est `ghost sm` ; `onRetry` et `message` y sont obligatoires, sans eux la ligne
//   ne dit rien et ne propose rien. La ligne passe à la ligne quand la largeur manque (220 px) plutôt que de couper le bouton.
// - Le texte du bouton par défaut (`Retry`) est en anglais : à localiser par qui copie le fichier, ou à passer en `retryLabel`. Un
//   `retryLabel` vide est un bug de l'appelant : aucun repli n'est posé, et Orca ne signale rien pour un `Button` vide, `orca plugin
//   check` ne peut pas le voir, le bouton est seulement blanc. Ne jamais en passer un.
// - Le message et le libellé du bouton passent par `clipText` (16000 unités), le titre par `clipLabel` (1000).
// - Tout est une seule liste plate clée (`message`, `retry`) : l'alerte garde la même forme avec ou sans message et avec ou sans bouton,
//   donc le bouton ne perd pas le focus quand un message apparaît.
//
// Ce que le bloc ne dit pas : un détail repliable (trace d'erreur), un deuxième geste à côté de Réessayer (Ouvrir les réglages),
// un compteur de tentatives, une icône sur l'alerte. Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 2 (`Callout`).
//
// Recette côté panneau, un atome pour l'erreur (null quand il n'y en a pas), un autre pour la liste déjà reçue :
//   const failure = atom<string | null>('failure', null)
//   {read(agents) === null && read(failure) !== null
//     ? <ErrorRetry title="Could not load agents" message={read(failure)!} onRetry={loadAgents} />
//     : null}
//   {read(agents) !== null && read(failure) !== null
//     ? <ErrorRetry kind="stale" message="Showing the last known agents." onRetry={loadAgents} />
//     : null}
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `clip-label.ts` avec lui).
import { Button, Callout, Row, Stack, Text, type OrcaElement } from 'orca'
import { clipLabel, clipText } from './clip-label'

export function ErrorRetry(
  props:
    | { kind?: 'error'; title: string; message?: string; retryLabel?: string; onRetry?: () => void }
    | { kind: 'stale'; message: string; retryLabel?: string; onRetry: () => void }
): OrcaElement {
  const retryLabel = clipText(props.retryLabel ?? 'Retry')
  if (props.kind === 'stale') {
    return (
      <Row align="center" gap="sm" wrap>
        <Text key="message" muted size="xs">
          {clipText(props.message)}
        </Text>
        <Button key="retry" variant="ghost" size="sm" onPress={props.onRetry}>
          {retryLabel}
        </Button>
      </Row>
    )
  }
  const onRetry = props.onRetry
  return (
    <Callout tone="danger" title={clipLabel(props.title.trim()) || 'Something went wrong'}>
      <Stack gap="sm">
        {/* Une seule liste plate et entièrement clée : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants. */}
        {[
          props.message ? (
            <Text key="message" size="sm">
              {clipText(props.message)}
            </Text>
          ) : null,
          onRetry === undefined ? null : (
            <Row key="retry">
              <Button variant="outline" size="sm" onPress={onRetry}>
                {retryLabel}
              </Button>
            </Row>
          )
        ]}
      </Stack>
    </Callout>
  )
}
