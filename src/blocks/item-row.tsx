// ItemRow : une ligne d'entité, une pastille de tête, un titre et un sous-titre tronqués, un statut et 0 à 2 actions en icône.
//
// Quand l'utiliser : chaque ligne d'une liste d'entités (agents, profils, fournisseurs, résultats), seule ou dans un `GroupCard`.
// Origine : agent-network (ligne d'agent), agent-profiles (ligne de profil), agent-skills (ligne de résultat).
// Quand ne pas l'utiliser : pour une ligne dont la fin est un bouton avec texte (« Add »), un `Row` sur mesure ;
// pour une ligne à plusieurs colonnes de données, un `Table` ; pour un menu cliquable, une `List`.
//
// Pièges :
// - Le texte prend la place libre et se tronque ; le statut et les actions gardent leur taille : à 360 px les icônes forment une colonne
//   quelle que soit la longueur du titre (à 220 px, voir la puce suivante). Le bloc n'a ni marge ni fond : la ligne se pose à même le fond de son parent.
// - Le titre garde une largeur minimale (`TITLE_MIN_WIDTH`) : quand la ligne est trop étroite (220 px), le statut et les actions passent
//   sous le titre, alignés à droite ; à 360 px rien ne change.
// - Une action basculée se dit par `active: true` : elle est dessinée en `outline`, sinon en `ghost` (`tone: 'accent'` sur un `ghost` est invisible sur le thème sombre).
//   `active` est purement visuel (l'`IconButton` du catalogue n'a pas d'état pressé) : le `label` de l'action doit dire l'état vers lequel ou depuis lequel elle bascule.
// - L'emplacement de tête a une largeur fixe (`LEAD_SLOT_WIDTH`) : image et monogramme s'alignent d'une ligne à l'autre.
//   Sans `lead`, aucun emplacement n'est réservé. Un monogramme vide garde son emplacement, sans pastille.
// - La tête est une image ou un monogramme, jamais une icône : le catalogue n'a pas d'icône seule, et un `IconButton` désactivé qui en
//   tient lieu est grisé, annoncé comme un bouton indisponible, et montre l'identifiant brut de l'icône en infobulle (constaté en 1.4.269) ;
//   la même icône sur chaque ligne distingue aussi moins les lignes qu'un monogramme.
// - L'image est un fichier du plugin (`assets/...`), jamais une URL ; en capture fixe elle montre son espace réservé. Elle est dessinée en
//   `fit="cover"` : Orca ne la carre que dans ce mode, sinon une image large devient une bande de 28 px sur 11 (le rendu de Orca,
//   `PluginDeclarativeImage`). Le coin est `rounded` (un arrondi moyen) : le catalogue n'offre pas de rond complet comme la pastille du monogramme.
// - Un monogramme ne distingue les lignes que si leurs textes diffèrent dès la première lettre : trois lignes « Item 1 », « Item 2 », « Item 3 » affichent toutes « I ».
// - La pastille du monogramme prend la surface inverse de celle où la ligne est posée, dite par `surface` : `'group'` (défaut, une ligne
//   dans un `GroupCard` sur `muted`) la dessine en `card`, `'panel'` (une ligne à nu sur le fond du volet) la dessine en `muted`. Constaté sur le
//   thème sombre : `card` se fond dans le fond du volet, `muted` se fond dans un groupe `muted`. Seule la première lettre du texte est dessinée, en capitales.
// - Le statut est un `Badge` : préférer `neutral`, `success`, `warning`, `danger`. `accent` est dessiné en pastille pleine et se lit
//   comme une action principale (constaté sur le thème sombre). Sur un `GroupCard`, le badge `neutral` se fond dans le fond, son texte reste lisible.
// - Le sous-titre est une chaîne simple : pas de `Code` ni de `RelativeTime` en ligne (voir « Ce que le bloc ne dit pas » plus bas).
// - Une action est identifiée par son `key` si elle en a une, sinon par son index (`action-key-<key>` ou
//   `action-index-<i>`, jamais le libellé ni l'icône) : donner un `key` aux actions qui apparaissent ou disparaissent selon l'état, sinon le focus se perd ;
//   deux `key` identiques dans une liste sont à la charge de l'appelant (Orca refuse tout le rendu). Un libellé d'action vide est un bug de
//   l'appelant : Orca le refuse (avertissement), `orca plugin check` le signale, aucun repli n'est posé.
// - Chaque niveau est une seule liste plate clée (`lead-text` ⊃ `lead`, `text` ; `trailing` ⊃ `status`, `action-key-*`, `action-index-*`) : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants.
// - Libellés d'action par `clipLabel` (1 KiB), titre, sous-titre et statut par `clipText` (16384 unités par texte).
//
// Ce que le bloc ne dit pas : un badge collé au titre (« Last »), un nom en police monospace ou une heure relative dans le sous-titre,
// un bouton avec texte en fin de ligne, un chevron de tête, plus de deux actions utiles, une icône seule en tête (le catalogue n'en a pas :
// la tête d'une ligne est une image ou un monogramme). Adapter le fichier copié pour ces cas.
//
// Catalogue minimal : 4 (`Box`).
//
// Recette côté panneau : le bloc ne déclare aucun atome, une action qui change d'état (copié) se décrit par l'icône et le libellé :
//   const copied = atom<string | null>('copied', null)
//   <ItemRow lead={{ kind: 'monogram', text: agent.name }} title={agent.name} subtitle="opus · high" status={{ label: 'working', tone: 'neutral' }}
//     actions={[{ key: 'copy', icon: read(copied) === agent.id ? 'check' : 'copy', label: `Copy ${agent.name}`, onPress: () => copyId(agent) }]} />
//   Une ligne à nu sur le fond du volet (hors `GroupCard`) : ajouter `surface="panel"`.
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `icon-action.ts` et `clip-label.ts` avec lui).
import { Badge, Box, IconButton, Image, Text, type OrcaElement, type Tone } from 'orca'
import { clipLabel, clipText } from './clip-label'
import type { IconAction } from './icon-action'

export type ItemLead = { kind: 'image'; src: string } | { kind: 'monogram'; text: string }

// La surface où la ligne est posée : un groupe `muted` (défaut) ou le fond nu du volet.
export type ItemSurface = 'group' | 'panel'

// Largeur de l'emplacement de tête, en pixels : réglée à l'œil dans agent-profiles (agent-network en prend 20).
export const LEAD_SLOT_WIDTH = 28
// Écart `gap="sm"` de Box (gap-2, 8 px) : la largeur de base de la tête en dépend.
const ROW_GAP = 8
// Largeur minimale lisible du titre, en pixels (~14 caractères) : en dessous, le statut et les actions passent à la ligne.
// À 220 px dans un `GroupCard` (178 px utiles), tête + titre = 132 : statut ou deux actions (> 38 px) passent dessous ; à 360 (318 px) rien ne bouge.
const TITLE_MIN_WIDTH = 96
// La pastille est un peu plus petite que son emplacement, pour n'en toucher aucun bord.
const MONOGRAM_SIZE = LEAD_SLOT_WIDTH - 3

function renderLeadContent(lead: ItemLead, surface: ItemSurface): OrcaElement | null {
  if (lead.kind === 'image') return <Image src={lead.src} alt="" size="xs" fit="cover" rounded />
  const initial = Array.from(lead.text.trim())[0]
  if (initial === undefined) return null
  return (
    <Box width={MONOGRAM_SIZE} height={MONOGRAM_SIZE} radius="full" background={surface === 'panel' ? 'muted' : 'card'} align="center" justify="center">
      <Text size="xs" weight="medium">
        {initial.toUpperCase()}
      </Text>
    </Box>
  )
}

export function ItemRow(props: {
  lead?: ItemLead
  title: string
  subtitle?: string
  emphasized?: boolean
  surface?: ItemSurface
  status?: { label: string; tone?: Tone }
  actions?: readonly IconAction[]
}): OrcaElement {
  const actions = props.actions ?? []
  const hasTrailing = props.status !== undefined || actions.length > 0
  // Base de la tête et du texte : c'est elle qui décide du retour à la ligne du statut et des actions.
  const leadTextWidth = (props.lead === undefined ? 0 : LEAD_SLOT_WIDTH + ROW_GAP) + TITLE_MIN_WIDTH
  return (
    <Box direction="row" wrap align="center" justify="end" gap="sm" paddingY="sm">
      {/* Une seule liste plate et entièrement clée à chaque niveau : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants. */}
      {[
        <Box key="lead-text" direction="row" align="center" gap="sm" grow width={leadTextWidth}>
          {[
            props.lead === undefined ? null : (
              <Box key="lead" width={LEAD_SLOT_WIDTH} shrink={false} align="center" justify="center">
                {renderLeadContent(props.lead, props.surface ?? 'group')}
              </Box>
            ),
            <Box key="text" grow minWidth={0}>
              <Text weight={props.emphasized ? 'semibold' : 'medium'} truncate>
                {clipText(props.title)}
              </Text>
              {props.subtitle ? (
                <Text muted size="xs" truncate>
                  {clipText(props.subtitle)}
                </Text>
              ) : null}
            </Box>
          ]}
        </Box>,
        hasTrailing ? (
          <Box key="trailing" direction="row" align="center" gap="sm" shrink={false}>
            {[
              props.status === undefined ? null : (
                <Box key="status" shrink={false}>
                  <Badge tone={props.status.tone}>{clipText(props.status.label)}</Badge>
                </Box>
              ),
              ...actions.map((action, index) => (
                // La clé de l'action si elle en a une, sinon l'index : jamais le libellé ni l'icône, qui peuvent se répéter.
                <Box key={action.key === undefined ? `action-index-${index}` : `action-key-${action.key}`} shrink={false}>
                  <IconButton
                    icon={action.icon}
                    label={clipLabel(action.label)}
                    variant={action.active ? 'outline' : 'ghost'}
                    size="sm"
                    tone={action.tone}
                    disabled={action.disabled}
                    onPress={action.onPress}
                  />
                </Box>
              ))
            ]}
          </Box>
        ) : null
      ]}
    </Box>
  )
}
