// SectionCollapsible : une section repliable dont l'état est tenu par le panneau, avec un résumé quand elle est fermée.
//
// Quand l'utiliser : une section d'un panneau qu'on veut pouvoir replier (Messages, Configurations), avec un résumé
// d'une ligne (« 3 unread ») visible tant qu'elle est fermée. Origine : agent-network (Messages), agent-claude-managed (home).
// Quand ne pas l'utiliser : pour un accordéon où une seule section reste ouverte, empiler des `Collapsible` natifs
// avec `defaultOpen` ; pour une section toujours visible, un `Heading` et un `Stack`.
//
// Pièges :
// - Le bloc est contrôlé : `open` et `onChange` sont obligatoires, car un bloc ne déclare aucun atome (deux copies
//   du bloc dans un panneau partageraient le même atome et s'ouvriraient ensemble).
// - Le résumé n'est passé qu'à section fermée : ouverte, le contenu parle de lui-même.
// - `title` et `summary` passent par `clipLabel` ; `Collapsible.title` n'accepte qu'une chaîne, pas d'élément, ni une chaîne vide (repli `Untitled`, texte en anglais à localiser par qui copie le fichier).
//
// Catalogue minimal : 2 (`Collapsible`).
//
// Recette côté panneau, un atome par section, avec une clé distincte :
//   const messagesOpen = atom('messagesOpen', false, { persist: 'plugin' })
//   <SectionCollapsible title="Messages" summary="3 unread" open={read(messagesOpen)} onChange={(next) => set(messagesOpen, next)}>
//     {body}
//   </SectionCollapsible>
// Plusieurs sections : un seul atome objet (`{ messages: false, configs: true }`) mis à jour avec `update`.
//
// Imports : uniquement `orca` et des fichiers de `src/blocks/` (copier `clip-label.ts` avec lui).
import { Collapsible, type OrcaElement, type OrcaNode } from 'orca'
import { clipLabel } from './clip-label'

export function SectionCollapsible(props: {
  title: string
  summary?: string
  open: boolean
  onChange: (open: boolean) => void
  children?: OrcaNode
}): OrcaElement {
  const description = !props.open && props.summary ? clipLabel(props.summary) : undefined
  return (
    <Collapsible title={clipLabel(props.title.trim()) || 'Untitled'} description={description} open={props.open} onChange={props.onChange}>
      {props.children}
    </Collapsible>
  )
}
