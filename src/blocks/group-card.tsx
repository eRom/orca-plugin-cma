// GroupCard : un groupe titré de lignes séparées par un filet, posé sur une surface encadrée.
//
// Quand l'utiliser : regrouper des `ItemRow` (les agents d'un workspace, les profils d'un agent) sous un titre, avec à droite
// un élément libre (un `+`, un compteur). Origine : agent-profiles (groupe d'agent), agent-network (groupe de workspace).
// Quand ne pas l'utiliser : pour une liste plate sans cadre, empiler des lignes et des `Separator` à la main ;
// pour un groupe qu'on replie, le bloc `SectionCollapsible` ; pour un contenu libre sur une carte, `Card`.
//
// Pièges :
// - La surface est `muted` avec une bordure : sur le thème sombre, `card` se confond avec le fond du volet, `muted` reste visible
//   (constaté dans agent-profiles et agent-network). Un `Badge` neutre y est peu visible, un monogramme sur `card` s'y détache.
// - Les lignes sont séparées par un `Separator`, jamais avant la première ni après la dernière. Une ligne `null`, `undefined` ou `false`
//   est ignorée, sans filet orphelin : on peut passer `rows` avec des conditions.
// - Chaque ligne est posée dans un conteneur clé, et le filet qui la précède porte la clé de cette ligne (`rule-<clé de la ligne>`). Une ligne simple
//   est clée par sa position DANS `rows`, avant tout retrait des lignes vides (`row-index-<i>`) : `[cond ? A : null, B]` garde donc B sous la même
//   clé que A soit là ou non, et B ne perd pas son état. Une liste construite depuis des données passe des lignes `{ key, row }` clées par l'identifiant
//   de la donnée (`row-key-<key>`) : une ligne qui change de place ou dont une voisine disparaît garde son état (le focus d'un bouton).
//   Un `key` posé sur l'élément de la ligne ne sert à rien : le bloc le recouvre. Deux `key` identiques sont à la charge de l'appelant (Orca refuse tout le rendu).
// - Sans titre ni `trailing`, aucun en-tête n'est dessiné. Sans ligne, le groupe ne dessine que son en-tête : poser une ligne
//   de texte (`Text muted size="xs"`) pour dire « rien ici ».
// - `trailing` garde sa taille (le titre se tronque, jamais l'inverse) ; y mettre un `IconButton` ou un compteur, pas un long texte.
// - Le titre passe par `clipText` (16384 unités par texte).
// - Tout est une seule liste plate clée (`header`, `row-key-*`, `row-index-*`, `rule-*`) : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants.
//
// Ce que le bloc ne dit pas : un chevron ou une icône de tête dans l'en-tête, un groupe actif mis en valeur (agent-network passe le
// fond de `muted` à `none`), un état replié. Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 4 (`Box`).
//
// Panneau : le bloc ne déclare aucun atome ; les lignes viennent de l'appelant. Une liste construite depuis des données : des lignes `{ key, row }` ;
// une liste fixe : des noeuds simples, avec `null` pour une ligne conditionnelle.
//   <GroupCard title="Claude" trailing={<IconButton icon="add" label="New profile" variant="ghost" size="sm" onPress={addProfile} />}
//     rows={profiles.map((profile) => ({ key: profile.id, row: <ItemRow title={profile.name} /> }))} />
//   <GroupCard rows={[<ItemRow title="Claude" />, hasCodex ? <ItemRow title="Codex" /> : null]} />
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `clip-label.ts` avec lui).
import { Box, Separator, Text, type OrcaElement, type OrcaNode } from 'orca'
import { clipText } from './clip-label'

// Une ligne clée par l'appelant : `key` est l'identifiant de la donnée. Deux `key` identiques dans `rows` sont à sa charge : Orca refuse alors tout le rendu.
export type KeyedRow = { key: string; row: OrcaNode }

function isKeyedRow(entry: OrcaNode | KeyedRow): entry is KeyedRow {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) && !('$$typeof' in entry) && 'row' in entry && typeof (entry as KeyedRow).key === 'string'
}

export function GroupCard(props: { title?: string; trailing?: OrcaNode; rows: readonly (OrcaNode | KeyedRow)[] }): OrcaElement {
  const hasTrailing = props.trailing !== undefined && props.trailing !== null && props.trailing !== false
  // La clé se prend sur la position d'origine, avant de retirer les lignes vides : une ligne conditionnelle qui disparaît ne décale pas ses voisines.
  const rows = props.rows
    .map((entry, index) => (isKeyedRow(entry) ? { id: `row-key-${entry.key}`, row: entry.row } : { id: `row-index-${index}`, row: entry }))
    .filter(({ row }) => row !== null && row !== undefined && row !== false)
  return (
    <Box border radius="md" padding="sm" background="muted">
      {/* Une seule liste plate et entièrement clée : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants. */}
      {[
        props.title || hasTrailing ? (
          <Box key="header" direction="row" align="center" justify="between" gap="sm" paddingY="xs">
            {/* Le conteneur du titre existe même sans titre : il pousse `trailing` à droite. */}
            <Box key="title" grow minWidth={0}>
              {props.title ? (
                <Text weight="semibold" truncate>
                  {clipText(props.title)}
                </Text>
              ) : null}
            </Box>
            {hasTrailing ? (
              <Box key="trailing" shrink={false}>
                {props.trailing}
              </Box>
            ) : null}
          </Box>
        ) : null,
        ...rows.flatMap(({ id, row }, index) => [
          // Le filet vient avant chaque ligne sauf la première, avec la clé de la ligne qu'il précède : aucun filet au bord du groupe.
          ...(index === 0 ? [] : [<Separator key={`rule-${id}`} />]),
          <Box key={id}>{row}</Box>
        ])
      ]}
    </Box>
  )
}
