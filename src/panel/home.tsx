// Accueil du panneau. Pour l'instant : la section « Anthropic workspace » (clé et identité).
// Les sections Configurations et Sessions arrivent avec les tâches suivantes.
import { atom, Button, Callout, Collapsible, Input, Link, plugin, read, Row, set, Stack, Text, update } from 'orca'
import { run, sectionsOpen, workspace } from './state'

const keyDraft = atom('')
const KEY_REJECTED = 'The API key was rejected (401).'

async function saveKey(): Promise<void> {
  const result = await plugin.request('key.set', { key: read(keyDraft).trim() })
  if (result.ok) {
    set(keyDraft, '')
    set(workspace, result.value)
    return
  }
  // Le worker a supprimé la clé refusée ; le brouillon reste, pour être corrigé sans tout retaper.
  if (result.code === 'unauthorized') {
    // Le formulaire revient avec l'avis.
    set(workspace, { hasKey: false, keyRejected: true, workspaceId: null, organizationName: null })
    return
  }
  throw new Error(result.error)
}

async function forgetKey(): Promise<void> {
  set(workspace, await plugin.request('key.clear'))
}

function KeyForm({ rejected }: { rejected: boolean }) {
  return (
    <Stack gap="sm">
      {rejected ? <Callout tone="danger" title={KEY_REJECTED} /> : null}
      <Callout tone="warning" title="Add your Anthropic API key">
        <Stack gap="sm">
          <Text muted size="sm">
            Orca stores it encrypted in your OS keyring. Only this plugin's worker uses it.
          </Text>
          <Input
            label="API key"
            type="password"
            placeholder="sk-ant-..."
            value={read(keyDraft)}
            onChange={(value) => set(keyDraft, value)}
            onSubmit={() => run(saveKey)}
          />
          <Button onPress={() => run(saveKey)} disabled={!read(keyDraft).trim()}>
            Save key
          </Button>
        </Stack>
      </Callout>
    </Stack>
  )
}

function WorkspaceLine() {
  const info = read(workspace)
  const label = [info?.workspaceId, info?.organizationName].filter(Boolean).join(' · ')
  return (
    <Stack gap="sm">
      <Text>{label || 'Workspace unknown'}</Text>
      <Row gap="sm" wrap>
        {info?.workspaceId ? (
          <Link href={`https://platform.claude.com/workspaces/${info.workspaceId}/agents`}>Console</Link>
        ) : null}
        <Button variant="ghost" tone="danger" size="sm" onPress={() => run(forgetKey)}>
          Forget key
        </Button>
      </Row>
    </Stack>
  )
}

export function Home() {
  const info = read(workspace)
  if (!info) {
    return null
  }
  const needsKey = !info.hasKey || info.keyRejected
  // La section est repliée par défaut, mais reste ouverte tant que la clé manque ou est refusée.
  const open = needsKey || read(sectionsOpen).workspace
  return (
    <Stack gap="md">
      <Collapsible
        title="Anthropic workspace"
        open={open}
        onChange={(next) => update(sectionsOpen, (current) => ({ ...current, workspace: next }))}
      >
        {needsKey ? <KeyForm rejected={info.keyRejected} /> : <WorkspaceLine />}
      </Collapsible>
    </Stack>
  )
}
