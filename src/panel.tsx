// Panneau Managed Agents : aucun réseau ici, tout passe par le worker (`plugin.request`).
// Il route sur le sommet de la pile de navigation ; une vue inconnue retombe sur l'accueil.
import { Callout, plugin, read, set, Spinner, Stack, type PanelContext } from 'orca'
import { POLL_VISIBLE_MS } from './protocol'
import { Home } from './panel/home'
import { loadSessions, loadWorkspace, nav, notice, run, sessionRows, workspace } from './panel/state'

export function setup(ctx: PanelContext): void {
  // Le worker pousse la liste des sessions ; une liste vide peut aussi signer une clé refusée.
  ctx.subscriptions.push(
    plugin.on('sessions.changed', ({ rows }) => {
      set(sessionRows, rows)
      const info = read(workspace)
      if (rows.length === 0 && info?.hasKey && !info.keyRejected) {
        run(loadWorkspace)
      }
    })
  )
  run(async () => {
    await loadWorkspace()
    await loadSessions()
  })

  // Le worker sonde vite tant qu'il sait le panneau visible : un ping au montage, puis toutes les 10 s.
  const ping = (): void => {
    plugin.request('sessions.visibility', { visible: true }).catch(() => {
      // Un ping perdu coûte au pire un tour lent : rien à montrer.
    })
  }
  ping()
  const timer = setInterval(() => {
    if (read(ctx.visible)) ping()
  }, POLL_VISIBLE_MS)
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
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
