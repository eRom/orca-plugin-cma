// Panneau Managed Agents : aucun réseau ici, tout passe par le worker (`plugin.request`).
// Il route sur le sommet de la pile de navigation ; une vue inconnue retombe sur l'accueil.
import { Callout, plugin, read, set, Spinner, Stack, Text, type PanelContext } from 'orca'
import { POLL_VISIBLE_MS } from './protocol'
import { ConfigDetailView, loadConfigs, MemoryView, restoreConfigView } from './panel/config-views'
import { Home } from './panel/home'
import { NewSessionView, restoreNewSession } from './panel/new-session'
import { restoreOpenSession, SessionView, sessionSubscriptions } from './panel/session-view'
import { clipBytes } from './shared/text'
import { ERROR_TEXT_LIMIT_BYTES, homeTab, loadSessions, loadWorkspace, nav, notice, run, sessionRows, workspace } from './panel/state'

export function setup(ctx: PanelContext): void {
  // Le worker pousse la liste des sessions ; une liste vide peut aussi signer une clé refusée.
  ctx.subscriptions.push(
    plugin.on('sessions.changed', ({ rows }) => {
      set(sessionRows, rows)
      const info = read(workspace)
      if (rows.length === 0 && info?.hasKey && !info.keyRejected) {
        run(loadWorkspace)
      }
    }),
    ...sessionSubscriptions()
  )
  run(async () => {
    await loadWorkspace()
    const info = read(workspace)
    // La pile persistée peut garder une session ou une configuration ouverte : on la rouvre, si une clé utilisable l'autorise.
    const reopen =
      info?.hasKey && !info.keyRejected
        ? Promise.all([restoreOpenSession(), restoreNewSession(), restoreConfigView(), loadConfigs(read(homeTab))])
        : Promise.resolve()
    await Promise.all([loadSessions(), reopen])
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
  const info = read(workspace)
  // Sans clé utilisable, aucune vue de détail ne peut se charger : l'accueil remontre le formulaire.
  if (!info?.hasKey || info.keyRejected) {
    return <Home />
  }
  switch (top?.view) {
    case 'session':
      return <SessionView sessionId={top.sessionId} />
    case 'newSession':
      return <NewSessionView />
    case 'config':
      return <ConfigDetailView kind={top.kind} id={top.id} />
    case 'memory':
      return <MemoryView memoryStoreId={top.memoryStoreId} memoryId={top.memoryId} />
    default:
      return <Home />
  }
}

export default function Panel() {
  const error = read(notice)
  const loaded = read(workspace) !== null
  return (
    <Stack gap="md">
      {error ? (
        <Callout tone="danger" title="Something went wrong">
          <Text size="sm">{clipBytes(error, ERROR_TEXT_LIMIT_BYTES).text}</Text>
        </Callout>
      ) : null}
      {loaded ? <CurrentView /> : error ? null : <Spinner label="Loading" />}
    </Stack>
  )
}
