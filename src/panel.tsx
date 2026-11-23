// Panneau Managed Agents : aucun réseau ici, tout passe par le worker (`plugin.request`).
// Il route sur le sommet de la pile de navigation ; une vue inconnue retombe sur l'accueil.
import { Callout, plugin, read, set, Spinner, Stack, Text, type PanelContext } from 'orca'
import { POLL_VISIBLE_MS } from './protocol'
import { AgentFormView } from './panel/agent-form'
import { loadConfigTab } from './panel/config-state'
import { ConfigDetailView, MemoryView, restoreConfigView } from './panel/config-views'
import { setupDrafts } from './panel/drafts'
import { EnvironmentFormView } from './panel/environment-form'
import { Home } from './panel/home'
import { MemoryStoreFormView } from './panel/memory-forms'
import { NewSessionView, restoreNewSession } from './panel/new-session'
import { restoreOpenSession, SessionView, sessionSubscriptions } from './panel/session-view'
import { CredentialFormView, VaultFormView } from './panel/vault-forms'
import { adopt } from './panel/workspaces'
import { clipBytes } from './shared/text'
import {
  ERROR_TEXT_LIMIT_BYTES,
  loadSessions,
  loadWorkspace,
  nav,
  notice,
  run,
  sessionRows,
  threadLoaded,
  viewedSession,
  workspace
} from './panel/state'

export function setup(ctx: PanelContext): void {
  // La relecture de la carte d'installation des brouillons s'arrête avec le panneau.
  setupDrafts(ctx)
  // Le worker pousse la liste des sessions ; une liste vide peut aussi signer une clé refusée.
  ctx.subscriptions.push(
    plugin.on('sessions.changed', ({ rows }) => {
      set(sessionRows, rows)
      const info = read(workspace)
      if (rows.length === 0 && info?.hasKey && !info.keyRejected) {
        run(loadWorkspace)
      }
    }),
    // Un autre panneau a changé l'actif : celui-ci revient à l'accueil du nouveau, sans attendre son prochain relevé.
    plugin.on('workspace.changed', (info) => {
      run(() => adopt(info))
    }),
    ...sessionSubscriptions()
  )
  // Le worker sonde vite tant qu'il sait le panneau visible : un ping au montage, puis toutes les 10 s.
  // Sa réponse dit s'il a redémarré (`bootId`) et quelle session il suit : une vue ouverte dont le suivi
  // a disparu est rouverte, sinon son fil resterait figé après un redémarrage du worker.
  let lastBootId: string | null = null
  const ping = (): Promise<void> =>
    plugin
      .request('sessions.visibility', { visible: true })
      .then(({ bootId, watching }) => {
        const restarted = lastBootId !== null && bootId !== lastBootId
        lastBootId = bootId
        const viewed = read(viewedSession)
        // Sans fil chargé, la vue s'ouvre encore (le suivi n'a pas pu démarrer) : seul un redémarrage compte.
        if (viewed !== null && (restarted || (read(threadLoaded) && watching !== viewed))) {
          run(restoreOpenSession)
        }
      })
      .catch(() => {
        // Un ping perdu coûte au pire un tour lent : rien à montrer.
      })
  run(async () => {
    await loadWorkspace()
    const info = read(workspace)
    // La pile persistée peut garder une session ou une configuration ouverte : on la rouvre, si une clé utilisable l'autorise.
    const reopen =
      info?.hasKey && !info.keyRejected
        ? Promise.all([restoreOpenSession(), restoreNewSession(), restoreConfigView(), loadConfigTab()])
        : Promise.resolve()
    await Promise.all([loadSessions(), reopen])
    // Un ping une fois la vue restaurée : il vérifie que le worker suit bien ce que le panneau montre.
    await ping()
  })

  void ping()
  const timer = setInterval(() => {
    if (read(ctx.visible)) void ping()
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
    case 'newConfig':
      // Chaque type a son formulaire de création.
      if (top.kind === 'agent') return <AgentFormView id={null} />
      if (top.kind === 'environment') return <EnvironmentFormView id={null} />
      if (top.kind === 'memory_store') return <MemoryStoreFormView id={null} />
      return top.kind === 'vault' ? <VaultFormView id={null} /> : <Home />
    case 'credential':
      return <CredentialFormView vaultId={top.vaultId} credentialId={top.credentialId} />
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
