// Le câblage réel de src/worker.ts pour les brouillons (démarrage, projet masqué ou refusé), sur un hôte simulé.
// Le fichier ne s'appelle pas worker.test.ts : `bun test src/worker` le prendrait pour un spec du worker.
// HOME est redirigé vers un dossier temporaire avant d'importer le worker : l'ancien dossier de brouillons
// (LEGACY_DRAFTS_FOLDER, sous HOME) ne peut pas viser le vrai ~/.config.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, assert, hostError, mockHost, mountWorker, test } from 'orca/testing'

const fakeHome = mkdtempSync(join(tmpdir(), 'cma-worker-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

type Row = { id: string; name: string; kind: 'git' | 'folder'; hostId: string | null; path: string; hidden?: boolean }

type WorkerModule = Parameters<typeof mountWorker>[0]

const REF = { kind: 'agent', agentId: 'agent_1' } as never

/**
 * Le worker, empaqueté à part dans un dossier temporaire (jamais `dist/`, que le plugin chargé utilise) : Orca refuse
 * qu'un test importe le SDK depuis les sources, et le panneau charge justement le bundle.
 */
let bundled: Promise<WorkerModule> | null = null
function loadWorker(): Promise<WorkerModule> {
  bundled ??= (async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'cma-worker-bundle-')), 'worker.mjs')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    execFileSync('bun', ['build', join(root, 'src', 'worker.ts'), '--target=node', '--format=esm', `--outfile=${out}`], {
      cwd: root,
      stdio: 'pipe'
    })
    return import(pathToFileURL(out).href)
  })()
  return bundled
}

/** Les workers démarrés par un test : arrêtés à la fin (le sondeur garde sinon le processus de test en vie). */
const started: { deactivate(): Promise<void> }[] = []
async function start(host: ReturnType<typeof mockHost>) {
  const worker = await mountWorker(await loadWorker(), { host })
  started.push(worker)
  return worker
}
afterEach(async () => {
  for (const worker of started.splice(0)) await worker.deactivate()
})

/** Un hôte dont `project.list` rend les lignes courantes (modifiables entre deux requêtes). */
function hostFor(rows: Row[], flags: { failProjects: boolean } = { failProjects: false }) {
  return mockHost({
    capabilities: ['secrets:own', 'storage:own', 'workspace:read', 'workspace:write'],
    results: {
      'project.list': () => {
        if (flags.failProjects) throw hostError('unavailable', 'projects not ready')
        return { projects: rows.map((row) => ({ ...row })), truncated: false }
      },
      'workspace.list': () => ({
        workspaces: rows.map((row) => ({
          id: `ws-${row.id}`,
          kind: 'folder',
          name: row.name,
          projectId: row.id,
          path: row.path,
          branch: null,
          hostId: 'local'
        })),
        truncated: false
      }),
      'workspace.readContext': () => null,
      'statusBar.update': () => ({})
    }
  })
}

function twoProjects(): Row[] {
  const root = mkdtempSync(join(tmpdir(), 'cma-worker-projects-'))
  const rows: Row[] = [
    { id: 'p1', name: 'one', kind: 'folder', hostId: 'local', path: join(root, 'one') },
    { id: 'p2', name: 'two', kind: 'folder', hostId: 'local', path: join(root, 'two') }
  ]
  for (const row of rows) mkdirSync(row.path)
  return rows
}

test('a project hidden after start makes drafts unavailable', async () => {
  const rows = twoProjects()
  const worker = await start(hostFor(rows))
  const chosen = await worker.request('drafts.choose', { projectId: 'p1' })
  assert.equal(chosen.ok, true)
  const folder = join(rows[0].path, 'managed-agents')
  assert.deepEqual(await worker.request('drafts.status'), { folder, ready: true })

  rows[0].hidden = true
  assert.deepEqual(await worker.request('drafts.status'), { folder: '', ready: false })
  const refused = await worker.request('draft.state', REF)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : null, 'drafts_missing')

  // Le projet revient dans la barre latérale : les brouillons aussi.
  rows[0].hidden = false
  assert.deepEqual(await worker.request('drafts.status'), { folder, ready: true })
  assert.deepEqual(await worker.request('draft.state', REF), { ok: true, value: null })
})

test('a failed project read at start recovers on the next request', async () => {
  const rows = twoProjects()
  const flags = { failProjects: false }
  const host = hostFor(rows, flags)
  // Un premier démarrage retient le projet ; le second le retrouve, mais `project.list` est refusé à l'activation.
  const first = await mountWorker(await loadWorker(), { host })
  assert.equal((await first.request('drafts.choose', { projectId: 'p1' })).ok, true)
  await first.deactivate()
  flags.failProjects = true
  const worker = await start(host)
  assert.ok(worker.logs.some((line) => line.includes('drafts folder not resolved')))

  flags.failProjects = false
  assert.deepEqual(await worker.request('drafts.status'), { folder: join(rows[0].path, 'managed-agents'), ready: true })
  assert.deepEqual(await worker.request('draft.state', REF), { ok: true, value: null })
})
