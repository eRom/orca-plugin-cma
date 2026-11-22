// Panneau Managed Agents : aucun réseau ici, tout passe par le worker (`plugin.request`).
// Il route sur le sommet de la pile de navigation ; une vue inconnue retombe sur l'accueil.
import { Callout, read, Spinner, Stack, type PanelContext } from 'orca'
import { Home } from './panel/home'
import { loadWorkspace, nav, notice, run, workspace } from './panel/state'

export function setup(_ctx: PanelContext): void {
  run(loadWorkspace)
}

function CurrentView() {
  const top = read(nav).at(-1)
  switch (top?.view) {
    // Les autres vues (détail, session, nouvelle session) arrivent avec les tâches suivantes.
    default:
      return <Home />
  }
}

export default function Panel() {
  const error = read(notice)
  const loaded = read(workspace) !== null
  return (
    <Stack gap="md">
      {error ? <Callout tone="danger" title={error} /> : null}
      {loaded ? <CurrentView /> : error ? null : <Spinner label="Loading" />}
    </Stack>
  )
}
