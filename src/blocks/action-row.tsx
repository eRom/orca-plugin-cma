// ActionRow : un groupe de boutons d'un geste, et sous lui le résultat du geste en lignes d'un bandeau.
//
// Quand l'utiliser : les gestes d'un panneau qui rendent compte (Installer / Désinstaller avec « Claude : installé »). Origine :
// agent-network (actions de consigne et leur retour), agent-skills (note d'un geste, panel-row).
// Quand ne pas l'utiliser : pour le pied d'un formulaire, `FormSection` ; pour une icône seule, `IconButton` dans `ItemRow` ;
// pour un seul message sans bouton, un `Callout`.
//
// Pièges :
// - Le bloc ne déclare aucun atome : le retour (`feedback`) vient de l'appelant, qui le vide ou le remplace à chaque geste (recette plus bas).
// - Les boutons sont en `size="sm"`, `outline` par défaut : la variante `solid` est réservée au geste principal, une seule par rangée.
// - `feedback.title` est obligatoire : un `Callout` sans titre reçoit celui d'Orca d'après son ton (constaté en 1.4.269 : « Tip » pour `success`,
//   « Warning » pour `warning`, « Caution » pour `danger`), et « Claude : installé » se retrouvait titré « Tip ». Le titre dit ce qui s'est passé
//   (« Installed », « Install failed ») ; il passe par `clipLabel` (1 KiB), les lignes par `clipText`. Un titre vide est un bug de l'appelant :
//   le bloc pose le repli `Result`, en anglais, à localiser par qui copie le fichier, pour qu'Orca ne pose jamais le sien.
// - `feedback` ne dessine rien sans ligne. Le ton est `success`, `warning` ou `danger` : il se choisit sur la pire ligne, côté appelant.
// - Une ligne par `Text size="xs"` ; chacune est clée par sa position, deux lignes identiques ne cassent pas le rendu.
// - Sans action, la rangée n'est pas dessinée (seul le bandeau reste, s'il y en a un) ; le conteneur ne change pas de forme quand le
//   retour apparaît, donc les boutons ne perdent pas le focus au clic.
// - Une action est identifiée par son `key` si elle en a une, sinon par son index (`action-key-<key>` ou
//   `action-index-<i>`, jamais le libellé ni l'icône) : donner un `key` aux actions qui apparaissent ou disparaissent selon l'état, sinon le focus se perd ;
//   deux `key` identiques dans une liste sont à la charge de l'appelant (Orca refuse tout le rendu).
// - Un libellé de bouton vide est un bug de l'appelant, aucun repli n'est posé, et Orca ne signale rien pour un `Button` vide : `orca plugin check`
//   ne peut pas le voir, le bouton est seulement blanc. Ne jamais en passer un. Chaque libellé et chaque ligne passe par `clipText` (16384 unités par texte).
// - Tout est une seule liste plate clée (`actions`, `feedback`) ; les boutons de la rangée sont clés `action-key-*` ou `action-index-*`.
//
// Ce que le bloc ne dit pas : un bandeau sans titre (Orca en poserait un), un retour en deux bandeaux (erreurs puis avertissements, agent-skills),
// une ligne de retour avec une erreur détaillée en seconde partie, une progression (`Spinner`). Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 2 (`Callout`).
//
// Recette côté panneau, un atome pour le retour du dernier geste :
//   const feedback = atom<{ tone: 'success' | 'warning' | 'danger'; title: string; lines: string[] } | null>('feedback', null)
//   <ActionRow actions={[{ label: 'Install', variant: 'solid', onPress: install }, { label: 'Uninstall', onPress: uninstall }]}
//     feedback={read(feedback) ?? undefined} />   // avec { tone: 'success', title: 'Installed', lines: ['Claude: installed'] }
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `icon-action.ts` et `clip-label.ts` avec lui).
import { Button, Callout, Row, Stack, Text, type OrcaElement } from 'orca'
import { clipLabel, clipText } from './clip-label'
import type { ButtonAction } from './icon-action'

export function ActionRow(props: {
  actions: readonly ButtonAction[]
  feedback?: { tone: 'success' | 'warning' | 'danger'; title: string; lines: readonly string[] }
}): OrcaElement {
  const feedback = props.feedback !== undefined && props.feedback.lines.length > 0 ? props.feedback : undefined
  return (
    <Stack gap="sm">
      {/* Une seule liste plate et entièrement clée : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants. */}
      {[
        props.actions.length === 0 ? null : (
          <Row key="actions" gap="sm" wrap>
            {props.actions.map((action, index) => (
              // La clé de l'action si elle en a une, sinon l'index : jamais le libellé ni l'icône, qui peuvent se répéter.
              <Button
                key={action.key === undefined ? `action-index-${index}` : `action-key-${action.key}`}
                size="sm"
                variant={action.variant ?? 'outline'}
                tone={action.tone}
                icon={action.icon}
                disabled={action.disabled}
                onPress={action.onPress}
              >
                {clipText(action.label)}
              </Button>
            ))}
          </Row>
        ),
        feedback === undefined ? null : (
          <Callout key="feedback" tone={feedback.tone} title={clipLabel(feedback.title.trim()) || 'Result'}>
            <Stack gap="xs">
              {feedback.lines.map((line, index) => (
                <Text key={`line-${index}`} size="xs">
                  {clipText(line)}
                </Text>
              ))}
            </Stack>
          </Callout>
        )
      ]}
    </Stack>
  )
}
