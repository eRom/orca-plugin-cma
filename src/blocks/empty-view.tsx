// EmptyView : ce que dit un panneau ou une liste quand il n'y a rien à montrer, avec au plus une action pour en sortir.
//
// Quand l'utiliser : `panel` quand tout le panneau est vide (aucun profil, aucun agent) ; `list` quand une liste d'un panneau plus
// riche est vide (une ligne discrète dans un groupe). Origine : agent-claude-managed et agent-profiles (état vide du panneau),
// agent-network (ligne muette « aucun agent »).
// Quand ne pas l'utiliser : pour une erreur, prendre `ErrorRetry` ; pour un chargement, `LoadingState` ; pour un filtre qui ne trouve
// rien, un `panel` dont le titre le dit (« No match ») suffit, le bloc n'a pas d'état dédié.
//
// Pièges :
// - Le bloc ne déclare aucun atome : c'est l'appelant qui sait qu'une liste est vide, une fois chargée (recette plus bas).
// - `panel` est l'`EmptyState` natif, l'action (un seul bouton, `outline` par défaut) est son enfant ; sans `action` aucun bouton n'est dessiné.
//   Le bouton a la taille par défaut, l'action est ici le geste principal du panneau vide.
// - `list` est un `Text muted size="xs"`, sans titre ni action : pour une liste qu'on peut remplir d'un geste, prendre `panel`.
// - Le titre et la description passent par `clipLabel` (1000 unités), le texte de la ligne et le libellé de l'action par `clipText`
//   (16000). Un titre vide est refusé par Orca : repli `Nothing here yet`, texte en anglais, à localiser par qui copie le fichier.
// - L'action est identifiée par son `key` si elle en a une, sinon par `action-index-0` (`action-key-<key>`) ; un libellé d'action
//   vide est un bug de l'appelant, aucun repli n'est posé, et Orca ne signale rien pour un `Button` vide : `orca plugin check` ne peut
//   pas le voir, le bouton est seulement blanc. Ne jamais en passer un.
//
// Ce que le bloc ne dit pas : un état « vide » différent de « aucun résultat » avec deux actions, une icône sur la ligne `list`,
// un bouton secondaire. Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 1 (`EmptyState`, `Text`, `Button`).
//
// Recette côté panneau : la liste vient de l'appelant, le bloc ne sait pas quand elle est vide.
//   const profiles = atom<Profile[]>('profiles', [])
//   {read(profiles).length === 0
//     ? <EmptyView kind="panel" title="No profile yet" description="Add one to start." icon="package" action={{ label: 'Add profile', onPress: addProfile }} />
//     : <ProfileList profiles={read(profiles)} />}
//   Dans un groupe : <GroupCard title="Claude" rows={[<EmptyView kind="list" text="No agents in this workspace." />]} />
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `icon-action.ts` et `clip-label.ts` avec lui).
import { Button, EmptyState, Text, type IconName, type OrcaElement } from 'orca'
import { clipLabel, clipText } from './clip-label'
import type { ButtonAction } from './icon-action'

export function EmptyView(
  props:
    | { kind: 'panel'; title: string; description?: string; icon?: IconName; action?: ButtonAction }
    | { kind: 'list'; text: string }
): OrcaElement {
  if (props.kind === 'list') {
    return (
      <Text muted size="xs">
        {clipText(props.text)}
      </Text>
    )
  }
  const action = props.action
  return (
    <EmptyState
      title={clipLabel(props.title.trim()) || 'Nothing here yet'}
      description={props.description ? clipLabel(props.description) : undefined}
      icon={props.icon}
    >
      {action === undefined ? null : (
        // La clé de l'action si elle en a une, sinon l'index : le bouton garde son identité quand le reste du panneau bouge.
        <Button
          key={action.key === undefined ? 'action-index-0' : `action-key-${action.key}`}
          variant={action.variant ?? 'outline'}
          tone={action.tone}
          icon={action.icon}
          disabled={action.disabled}
          onPress={action.onPress}
        >
          {clipText(action.label)}
        </Button>
      )}
    </EmptyState>
  )
}
