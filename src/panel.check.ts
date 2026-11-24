// `orca plugin check` dessine le panneau une fois par scénario ; le worker y est remplacé par des
// réponses figées, donc aucun appel réseau et aucune clé.
import { defineCheck } from 'orca/testing'
import { BUILTIN_TOOLS } from './protocol'
import type {
  AgentDetail,
  AgentForm,
  ConfigDetail,
  ConfigKind,
  ConfigRow,
  CreateFormOptions,
  CredentialForm,
  DraftInfo,
  EnvironmentDetail,
  EnvironmentForm,
  FileRow,
  MemoryStoreDetail,
  SessionDetail,
  SessionRow,
  SkillRow,
  StreamState,
  ThreadRow
} from './protocol'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_check',
  workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }]
}

/** Deux workspaces associés, le premier actif. */
const WORKSPACES_INFO = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_01DemoDefaultWorkspace',
  workspaces: [
    { localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_01DemoDefaultWorkspace', active: true },
    { localId: 'ws_2', name: 'Staging', workspaceId: 'wrkspc_01DemoSecondWorkspace', active: false }
  ]
}

function workspacesScenario() {
  return {
    requests: {
      'workspace.info': WORKSPACES_INFO,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [] }
    }
  }
}

const session = {
  agentId: 'agent_check',
  agentName: 'Writer',
  budget: null,
  cost: { minor: '125', currency: 'USD' },
  pendingApprovals: 0
}

const CHECK_MEMORIES = [
  { id: 'mem_a', path: '/runbooks/deploy.md', sizeBytes: 2048, updatedAt: '2026-11-20T10:00:00Z' },
  { id: 'mem_b', path: '/runbooks/rollback.md', sizeBytes: 300, updatedAt: '2026-11-21T10:00:00Z' },
  { id: 'mem_c', path: '/SOUL.md', sizeBytes: 14, updatedAt: '2026-11-21T11:00:00Z' }
]

/** Le dossier de brouillons est prêt et aucune mémoire n'a de brouillon : l'écran d'une banque n'en dit rien. */
const NO_DRAFTS = {
  'drafts.status': { folder: '/Users/someone/.config/agent-claude-managed/managed-agents', ready: true },
  'draft.state': { ok: true as const, value: null }
}

const AGENT_FORM: AgentForm = {
  name: 'Incident commander',
  model: 'claude-haiku-5-5',
  effort: 'high',
  description: 'Triages incidents.',
  builtinTools: {
    enabled: true,
    policy: 'always_allow',
    tools: BUILTIN_TOOLS.map((name) => ({ name, enabled: name === 'web_search' ? false : null, policy: name === 'bash' ? 'always_ask' : null }))
  },
  mcpServers: [
    { name: 'github', url: 'https://api.githubcopilot.com/mcp/', policy: 'always_ask' },
    { name: 'linear', url: 'https://mcp.linear.app/mcp', policy: 'always_allow' }
  ],
  multiagent: {
    advisor: 'claude-opus-5',
    subagents: { enabled: true, inlineAgents: true, savedAgents: [{ id: 'agent_01helper', version: 2 }, { id: 'agent_01review', version: 1 }] },
    workflows: { enabled: false, inlineAgents: true, savedAgents: [] }
  },
  skills: [
    { type: 'custom', skillId: 'skill_01Aa', version: '1759178010641129' },
    { type: 'anthropic', skillId: 'xlsx', version: 'latest' }
  ]
}

/** Ce que l'écran d'un agent lit : les modèles de l'API, les skills (de l'espace et d'Anthropic) et le dossier de brouillons (prêt, sans brouillon). */
const AGENT_READS = {
  'agent.formOptions': { ok: true as const, value: { models: ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5'] } },
  'skills.list': {
    ok: true as const,
    value: [{ id: 'skill_01Aa', name: 'incident-triage', latestVersionId: '1759178010641129', updatedAt: '2026-11-21T10:00:00Z' }] satisfies SkillRow[]
  },
  'skills.listAnthropic': {
    ok: true as const,
    value: [
      { id: 'xlsx', name: 'xlsx', latestVersionId: '1', updatedAt: '2026-11-01T10:00:00Z' },
      { id: 'pdf', name: 'pdf', latestVersionId: '1', updatedAt: '2026-11-01T10:00:00Z' }
    ] satisfies SkillRow[]
  },
  ...NO_DRAFTS
}

/** Vitrine : un seul workspace Anthropic, au nom d'équipe neutre, et un projet de brouillons prêt. */
const SHOWCASE_INFO = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_01Hn4rPlatformTeam',
  workspaces: [{ localId: 'ws_1', name: 'Platform team', workspaceId: 'wrkspc_01Hn4rPlatformTeam', active: true }]
}

const SHOWCASE_SESSIONS: SessionRow[] = [
  {
    id: 'sesn_01release',
    title: 'Prepare the 2.4 release',
    agentId: 'agent_01release',
    agentName: 'Release captain',
    status: 'idle',
    badge: 'needs_approval',
    cost: { minor: '42', currency: 'USD' },
    budget: { minor: '100', currency: 'USD' },
    updatedAt: '2026-11-24T15:42:00Z',
    pendingApprovals: 1
  },
  {
    id: 'sesn_01docs',
    title: 'Update the API reference',
    agentId: 'agent_01docs',
    agentName: 'Docs writer',
    status: 'running',
    badge: 'running',
    cost: { minor: '18', currency: 'USD' },
    budget: null,
    updatedAt: '2026-11-24T15:40:00Z',
    pendingApprovals: 0
  },
  {
    id: 'sesn_01deps',
    title: 'Weekly dependency audit',
    agentId: 'agent_01deps',
    agentName: 'Dependency auditor',
    status: 'idle',
    badge: 'idle',
    cost: { minor: '9', currency: 'USD' },
    budget: null,
    updatedAt: '2026-11-24T09:12:00Z',
    pendingApprovals: 0
  },
  {
    id: 'sesn_01triage',
    title: 'Triage new issues',
    agentId: 'agent_01triage',
    agentName: 'Issue triager',
    status: 'terminated',
    badge: 'terminated',
    cost: { minor: '27', currency: 'USD' },
    budget: null,
    updatedAt: '2026-11-23T18:05:00Z',
    pendingApprovals: 0
  }
]

export default defineCheck({
  'no key': {
    requests: { 'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, workspaces: [] } }
  },
  'key saved': {
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true, value: [] }
    }
  },
  'key saved with sessions': {
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': {
        ok: true,
        value: [
          { ...session, id: 'sesn_idle', title: 'Quiet one', status: 'idle', badge: 'idle', updatedAt: '2026-11-22T12:00:00Z' },
          {
            ...session,
            id: 'sesn_wait',
            title: null,
            status: 'idle',
            badge: 'needs_approval',
            pendingApprovals: 2,
            updatedAt: '2026-11-22T09:00:00Z'
          },
          { ...session, id: 'sesn_run', title: 'Busy one', status: 'running', badge: 'running', updatedAt: '2026-11-22T11:00:00Z' }
        ]
      }
    }
  },
  'rejected key': {
    requests: { 'workspace.info': { hasKey: true, keyRejected: true, workspaceId: null, workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }] } }
  },
  // La section des workspaces : deux lignes, le badge Active sur la première, ✓ et ✎ sur la seconde.
  workspaces: workspacesScenario(),
  'workspaces-folded': { ...workspacesScenario(), persisted: { plugin: { workspacesOpen: false } } },
  // La clé de l'actif a disparu du Mac : badge Key missing, détail ouvert d'office sur New API key, onglets absents.
  'key missing': {
    requests: { 'workspace.info': { ...WORKSPACES_INFO, hasKey: false, workspaceId: null } }
  },
  // La clé de l'actif est refusée : badge Key rejected et même détail ouvert.
  'key rejected with two workspaces': {
    requests: { 'workspace.info': { ...WORKSPACES_INFO, keyRejected: true, workspaceId: null } }
  },
  'new session form': newSessionScenario(),
  'new environment form': newEnvironmentScenario(),
  // Le détail d'un environnement au repos : réseau limité, un paquet dans Packages, Archive et Delete en bas.
  'environment form': environmentDraftScenario(false),
  // Une saisie gardée sur une version plus ancienne que le détail : « Unsaved changes » et l'avis de conflit (Reload, Save anyway).
  'environment form conflict': environmentDraftScenario(),
  // Le formulaire d'un identifiant à jeton : le champ de remplacement du jeton, vide, avec son aide.
  'credential form bearer': credentialScenario('vcrd_bearer'),
  // Celui d'une variable d'environnement : nom de la variable en lecture seule, réseau limité, injection.
  'credential form variable': credentialScenario('vcrd_variable'),
  // Le formulaire de création : le choix du type (Select) et le champ du jeton, vides.
  'credential form new': credentialScenario(null),
  // Un identifiant OAuth : lu seulement, Archive et Delete.
  'credential oauth': credentialScenario('vcrd_oauth'),
  'new vault form': {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'vault' }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [] }
    }
  },
  'configurations agents': {
    persisted: { plugin: { 'home.tab': 'agent' } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'sessions.list': { ok: true as const, value: [] },
      'configs.list': {
        ok: true as const,
        value: [
          { kind: 'agent', id: 'agent_check', name: 'Incident commander', summary: 'v3 · claude-haiku-5-5' },
          { kind: 'agent', id: 'agent_other', name: 'Writer', summary: 'v1 · claude-sonnet-5' }
        ] satisfies ConfigRow[]
      }
    }
  },
  // L'onglet Resources : deux skills (un nom de 120 caractères) et trois fichiers (9441 octets, 12 Mo, un lié à la session « Audit »).
  resources: {
    persisted: { plugin: { 'home.tab': 'resources' } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': {
        ok: true as const,
        value: [{ ...session, id: 'sesn_check', title: 'Audit', status: 'idle', badge: 'idle', updatedAt: '2026-11-22T12:00:00Z' }]
      },
      'skills.list': {
        ok: true as const,
        value: [
          { id: 'skill_01Aa', name: 'incident-triage', latestVersionId: '1759178010641129', updatedAt: '2026-11-21T10:00:00Z' },
          { id: 'skill_01Bb', name: 'a'.repeat(120), latestVersionId: '1759178010641130', updatedAt: '2026-11-22T09:30:00Z' }
        ] satisfies SkillRow[]
      },
      'files.list': {
        ok: true as const,
        value: [
          { id: 'file_01Aa', name: 'report.pdf', sizeBytes: 9441, createdAt: '2026-11-20T08:00:00Z', sessionId: null },
          { id: 'file_01Bb', name: 'dataset.csv', sizeBytes: 12_000_000, createdAt: '2026-11-21T08:00:00Z', sessionId: null },
          { id: 'file_01Cc', name: 'audit-notes.md', sizeBytes: 2048, createdAt: '2026-11-22T08:00:00Z', sessionId: 'sesn_check' }
        ] satisfies FileRow[]
      }
    }
  },
  // Le formulaire d'un agent au repos : champs, outils intégrés (réglages par outil repliés), serveurs MCP, résumés en lecture seule, Archive.
  'agent form': agentScenario(),
  // Une saisie gardée sur une version plus ancienne que le détail : « Unsaved changes », l'avis de départ, Review changes et Discard.
  'agent form unsaved': agentScenario({ unsaved: true }),
  // Le formulaire de création : vide, Create grisé, « New agent from YAML » et le bouton du lot 5, grisé.
  'new agent form': newAgentScenario(),
  // L'écran d'une banque : sans mémoire, avec trois mémoires, avec des lignes à envoyer (une en défaut), et le détail d'une mémoire.
  'memory store empty': memoryStoreScenario([]),
  'memory store filled': memoryStoreScenario(CHECK_MEMORIES),
  'memory store uploads': memoryStoreScenario(CHECK_MEMORIES, [
    { id: 'row_a', path: '/notes/today.md', file: '/Users/someone/notes/today.md', name: 'today.md', memoryId: null },
    // Un chemin déjà pris (la casse ne compte pas) : son message s'affiche sous la ligne et Apply est grisé.
    { id: 'row_b', path: '/Runbooks/Deploy.md', file: '/Users/someone/drafts/a-very-long-file-name-for-the-deploy-runbook.md', name: 'a-very-long-file-name-for-the-deploy-runbook.md', memoryId: null },
    { id: 'row_c', path: '', file: '', name: '', memoryId: null }
  ]),
  'memory detail': memoryDraftScenario({ ready: true, info: null }),
  // Le formulaire d'une banque dont la saisie gardée date d'une version plus ancienne : « Unsaved changes », l'avis de conflit, la liste des mémoires.
  'memory store form': memoryStoreFormScenario(),
  'new memory store form': {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'memory_store' }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [] }
    }
  },
  // Le bloc Drafts de la home : aucun projet retenu (état vide), puis un projet retenu (ligne et ✎).
  // La liste de choix s'ouvre à l'appui d'un bouton : un scénario ne sait que rendre, elle est jouée par `drafts.test.tsx`.
  'drafts section empty': draftsSectionScenario(false),
  'drafts section chosen': draftsSectionScenario(true),
  // Une mémoire ouverte sans projet de brouillons : le renvoi vers le bloc Drafts de la home s'affiche.
  'drafts missing project': memoryDraftScenario({ ready: false, info: null }),
  // Un brouillon gardé (fichier sauvegardé, pas appliqué) : « Unapplied draft from HH:MM », Apply et Discard.
  'drafts kept draft': memoryDraftScenario({
    ready: true,
    info: {
      ref: { kind: 'memory', memoryStoreId: 'memstore_check', memoryId: 'mem_a', path: '/runbooks/deploy.md' },
      file: 'memories/notes--memstore_check/runbooks/deploy.md',
      unapplied: true,
      writtenAt: '2026-11-22T10:00:00Z',
      savedAt: '2026-11-22T10:42:00Z',
      returnTo: { workspaceId: 'ws_orca', name: 'orca' }
    }
  }),
  vault: configScenario('vault', {
    kind: 'vault',
    id: 'vlt_check',
    name: 'GitHub',
    updatedAt: '2026-11-22T10:00:00Z',
    form: { name: 'GitHub' },
    credentials: [
      { id: 'vcrd_a', name: 'GitHub OAuth', type: 'mcp_oauth', mcpServerUrl: 'https://api.githubcopilot.com/mcp/', expiresAt: '2027-01-01T00:00:00Z', updatedAt: '2026-11-22T10:00:00Z', form: null },
      { id: 'vcrd_b', name: 'DEPLOY_TOKEN', type: 'environment_variable', mcpServerUrl: null, expiresAt: null, updatedAt: '2026-11-22T10:00:00Z', form: null }
    ]
  }),
  'session with approval': sessionScenario({
    row: sessionRow({ badge: 'needs_approval', pendingApprovals: 1, status: 'idle' }),
    rows: [
      text('u1', 'user_message', 'List the 3 most recent commits of **anthropics/anthropic-sdk-typescript**.'),
      text(
        'a1',
        'agent_message',
        "I'll look at the repository with the GitHub tools.\n\n1. Fetch the latest commits\n2. Summarise each one\n\nThen I'll open an issue if something looks off."
      ),
      tool('t1', 'list_commits', 'running', {
        input: '{\n  "owner": "anthropics",\n  "repo": "anthropic-sdk-typescript",\n  "per_page": 3\n}',
        result: '[{"sha":"f3a9c1e","message":"fix: retry on 529"},{"sha":"0b7d2aa","message":"chore: bump deps"}]',
        state: 'done'
      }),
      tool('t2', 'create_issue', 'awaiting_approval', {
        input: '{\n  "owner": "anthropics",\n  "repo": "anthropic-sdk-typescript",\n  "title": "Retry docs are out of date"\n}',
        needsConfirmation: true
      })
    ]
  }),
  // Un nom d'outil de 2 000 octets et un serveur de 100 : le titre du Collapsible est coupé, le rendu n'est pas refusé.
  'long tool title': sessionScenario({
    row: sessionRow({ badge: 'idle', status: 'idle' }),
    rows: [
      text('u1', 'user_message', 'Run the tool.'),
      {
        ...(tool('t1', 'x'.repeat(2_000), 'running', { input: '{}', result: 'ok', state: 'done' }) as Extract<ThreadRow, { kind: 'tool' }>),
        server: 's'.repeat(100)
      }
    ]
  }),
  'huge thread': sessionScenario({
    row: sessionRow({ badge: 'idle', status: 'idle' }),
    rows: Array.from({ length: 50 }, (_, index) => text(`h${index}`, index % 2 === 0 ? 'user_message' : 'agent_message', hugeText(index)))
  }),
  // 400 petites lignes : le panneau n'en dessine que la dernière page (100 au plus) et propose `Load earlier`.
  'long thread': sessionScenario({
    row: sessionRow({ badge: 'idle', status: 'idle' }),
    rows: Array.from({ length: 400 }, (_, index) => text(`l${index}`, index % 2 === 0 ? 'user_message' : 'agent_message', `Line ${index}`))
  }),
  // Le haut d'une vue de session : l'en-tête reste sobre, `Details` puis `Manage session` (fermée, l'état n'est pas semable).
  'session header actions': sessionScenario({
    row: sessionRow({ badge: 'idle', status: 'idle' }),
    rows: [text('u1', 'user_message', 'Triage INC-42'), text('a1', 'agent_message', 'On it.')]
  }),
  'terminated session': sessionScenario({
    row: sessionRow({ badge: 'terminated', status: 'terminated' }),
    rows: [
      text('u1', 'user_message', 'Triage INC-42'),
      text('a1', 'agent_message', 'Done. The root cause was a stale cache entry.'),
      { id: 's1', at: null, kind: 'status', text: 'Session terminated.', tone: 'neutral' }
    ]
  }),
  'budget reached': sessionScenario({
    row: sessionRow({ badge: 'budget_reached', status: 'idle', cost: { minor: '50', currency: 'USD' } }),
    rows: [
      text('u1', 'user_message', 'Refactor the whole repo.'),
      text('a1', 'agent_message', 'Starting with the parser module.'),
      { id: 's1', at: null, kind: 'status', text: 'Session stopped: budget reached.', tone: 'warning' }
    ]
  }),
  // Vitrine : les écrans des images de la fiche du plugin (media/shoot.sh), sur des données neutres et réalistes.
  'showcase sessions': showcase({
    persisted: { plugin: { workspacesOpen: false, draftsSectionOpen: false } },
    requests: {
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: SHOWCASE_SESSIONS }
    }
  }),
  'showcase approval': showcase(
    sessionScenario({
      row: SHOWCASE_SESSIONS[0]!,
      rows: [
        text('u1', 'user_message', 'Prepare the 2.4 release of **acme/web-app**: a changelog from the merged pull requests, then open the release pull request.'),
        text(
          'a1',
          'agent_message',
          "I'll gather what was merged since 2.3.\n\n1. List the merged pull requests\n2. Write the changelog\n3. Open the release pull request"
        ),
        tool('t1', 'list_pull_requests', 'running', {
          input: '{\n  "owner": "acme",\n  "repo": "web-app",\n  "state": "closed",\n  "base": "main"\n}',
          result: '[{"number":412,"title":"Faster cold start"},{"number":409,"title":"Dark mode for settings"}]',
          state: 'done'
        }),
        text('a2', 'agent_message', '14 pull requests merged since 2.3. The changelog is ready, opening the release pull request.'),
        tool('t2', 'create_pull_request', 'awaiting_approval', {
          input: '{\n  "owner": "acme",\n  "repo": "web-app",\n  "title": "Release 2.4.0",\n  "head": "release/2.4.0",\n  "base": "main"\n}',
          needsConfirmation: true
        })
      ]
    })
  ),
  'showcase agents': showcase({
    persisted: { plugin: { 'home.tab': 'agent', workspacesOpen: false, draftsSectionOpen: false } },
    requests: {
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'sessions.list': { ok: true as const, value: SHOWCASE_SESSIONS },
      'configs.list': {
        ok: true as const,
        value: [
          { kind: 'agent', id: 'agent_01release', name: 'Release captain', summary: 'v6 · claude-sonnet-5-5' },
          { kind: 'agent', id: 'agent_01docs', name: 'Docs writer', summary: 'v3 · claude-haiku-5-5' },
          { kind: 'agent', id: 'agent_01deps', name: 'Dependency auditor', summary: 'v2 · claude-haiku-5-5' },
          { kind: 'agent', id: 'agent_01triage', name: 'Issue triager', summary: 'v4 · claude-sonnet-5-5' }
        ] satisfies ConfigRow[]
      }
    }
  }),
  'showcase agent form': showcase(showcaseAgentScenario()),
  'showcase conflict': showcase(showcaseEnvironmentScenario()),
  'showcase resources': showcase({
    persisted: { plugin: { 'home.tab': 'resources', workspacesOpen: false, draftsSectionOpen: false } },
    requests: {
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: SHOWCASE_SESSIONS },
      'skills.list': {
        ok: true as const,
        value: [
          { id: 'skill_01Hn4rReleaseNotes', name: 'release-notes', latestVersionId: '1763971200000001', updatedAt: '2026-11-21T10:00:00Z' },
          { id: 'skill_01Hn4rChangelog', name: 'changelog-style', latestVersionId: '1763971200000002', updatedAt: '2026-11-20T10:00:00Z' },
          { id: 'skill_01Hn4rApiReference', name: 'api-reference', latestVersionId: '1763971200000003', updatedAt: '2026-11-18T10:00:00Z' }
        ] satisfies SkillRow[]
      },
      'files.list': {
        ok: true as const,
        value: [
          { id: 'file_01Hn4rChecklist', name: 'release-checklist.md', sizeBytes: 3_150, createdAt: '2026-11-20T08:00:00Z', sessionId: null },
          { id: 'file_01Hn4rSchema', name: 'api-schema.json', sizeBytes: 248_000, createdAt: '2026-11-21T08:00:00Z', sessionId: null },
          { id: 'file_01Hn4rCoverage', name: 'coverage-report.html', sizeBytes: 1_420_000, createdAt: '2026-11-22T08:00:00Z', sessionId: 'sesn_01release' }
        ] satisfies FileRow[]
      }
    }
  })
})

/** Pose le workspace et le projet de brouillons de la vitrine sur un scénario. */
function showcase<T extends { persisted?: { plugin?: Record<string, unknown> }; requests: Record<string, unknown> }>(scenario: T) {
  return {
    ...scenario,
    persisted: { plugin: { ...scenario.persisted?.plugin } },
    requests: {
      ...scenario.requests,
      'workspace.info': SHOWCASE_INFO,
      'drafts.status': { folder: '/Users/you/dev/web-app/managed-agents', ready: true },
      'draft.state': { ok: true as const, value: null },
      'drafts.projects': { ok: true as const, value: [{ id: 'p_web', name: 'web-app', path: '/Users/you/dev/web-app', current: true }] }
    }
  }
}

/** Vitrine : le formulaire d'un agent de release, outils GitHub et Linear, deux skills, un conseiller. */
function showcaseAgentScenario() {
  const form: AgentForm = {
    name: 'Release captain',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    description: 'Prepares each release: changelog, version bump and release pull request.',
    builtinTools: {
      enabled: true,
      policy: 'always_allow',
      tools: BUILTIN_TOOLS.map((name) => ({ name, enabled: null, policy: name === 'bash' ? 'always_ask' : null }))
    },
    mcpServers: [
      { name: 'github', url: 'https://api.githubcopilot.com/mcp/', policy: 'always_ask' },
      { name: 'linear', url: 'https://mcp.linear.app/mcp', policy: 'always_allow' }
    ],
    multiagent: {
      advisor: 'claude-opus-5-5',
      subagents: { enabled: true, inlineAgents: true, savedAgents: [{ id: 'agent_01docs', version: 3 }] },
      workflows: { enabled: false, inlineAgents: true, savedAgents: [] }
    },
    skills: [
      { type: 'custom', skillId: 'skill_01Hn4rReleaseNotes', version: 'latest' },
      { type: 'custom', skillId: 'skill_01Hn4rChangelog', version: 'latest' }
    ]
  }
  const detail: AgentDetail = {
    kind: 'agent',
    id: 'agent_01release',
    name: form.name,
    version: 6,
    form,
    model: form.model,
    effort: form.effort,
    description: form.description,
    system: { text: 'You are the release captain of the web app team.\n\nWrite changelogs for users, not for developers.', truncated: false },
    builtinTools: { enabled: true, policy: 'always_allow', overrides: [{ name: 'bash', enabled: true, policy: 'always_ask' }] },
    mcpServers: [
      { name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true, policy: 'always_ask', overrides: [] },
      { name: 'linear', url: 'https://mcp.linear.app/mcp', enabled: true, policy: 'always_allow', overrides: [] }
    ],
    multiagent: 'Multiagent: advisor claude-opus-5-5, subagents (1 predefined)',
    multiagentCoordinator: false
  }
  const scenario = configScenario('agent', detail)
  return {
    persisted: scenario.persisted,
    requests: {
      ...scenario.requests,
      'agent.formOptions': { ok: true as const, value: { models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] } },
      'skills.list': {
        ok: true as const,
        value: [
          { id: 'skill_01Hn4rReleaseNotes', name: 'release-notes', latestVersionId: '1763971200000001', updatedAt: '2026-11-21T10:00:00Z' },
          { id: 'skill_01Hn4rChangelog', name: 'changelog-style', latestVersionId: '1763971200000002', updatedAt: '2026-11-20T10:00:00Z' }
        ] satisfies SkillRow[]
      },
      'skills.listAnthropic': { ok: true as const, value: [] as SkillRow[] }
    }
  }
}

/** Vitrine : un environnement modifié ailleurs pendant la saisie, l'avis de conflit en tête. */
function showcaseEnvironmentScenario() {
  const form: EnvironmentForm = {
    name: 'Release sandbox',
    description: 'Builds and tests the web app before a release.',
    hosting: 'cloud',
    network: { mode: 'limited', allowedHosts: ['registry.npmjs.org', 'github.com'], allowPackageManagers: true, allowMcpServers: true },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: ['pnpm'], pip: [] },
    metadata: [{ key: 'team', value: 'platform' }]
  }
  const detail: EnvironmentDetail = {
    kind: 'environment',
    id: 'env_01release',
    name: form.name,
    description: form.description,
    updatedAt: '2026-11-24T10:00:00Z',
    form,
    hosting: 'cloud',
    network: form.network,
    packages: [{ key: 'npm', value: 'pnpm' }],
    metadata: form.metadata
  }
  const scenario = configScenario('environment', detail)
  return {
    ...scenario,
    persisted: {
      plugin: {
        ...scenario.persisted.plugin,
        'forms.drafts': {
          'environment:env_01release': {
            form: { ...form, description: 'Builds, tests and signs each release.' },
            base: form,
            baseStamp: '2026-11-23T09:00:00Z'
          }
        }
      }
    }
  }
}

/** Ligne de session : l'état du sondeur du worker, dont le panneau tire son badge. */
function sessionRow(over: Partial<SessionRow>): SessionRow {
  return {
    id: 'sesn_check',
    title: 'Triage the SDK repo',
    agentId: 'agent_check',
    agentName: 'Writer',
    status: 'idle',
    badge: 'idle',
    cost: { minor: '37', currency: 'USD' },
    budget: { minor: '50', currency: 'USD' },
    updatedAt: '2026-11-22T12:00:00Z',
    pendingApprovals: 0,
    ...over
  }
}

function text(id: string, kind: 'user_message' | 'agent_message', body: string): ThreadRow {
  return { id, at: null, kind, text: { text: body, truncated: false } }
}

function tool(
  id: string,
  name: string,
  state: 'running' | 'awaiting_approval',
  over: { input: string; result?: string; state?: 'done'; needsConfirmation?: boolean }
): ThreadRow {
  return {
    id,
    at: null,
    kind: 'tool',
    name,
    server: 'github',
    input: { text: over.input, truncated: false },
    result: over.result ? { text: over.result, truncated: false } : null,
    state: over.state ?? state,
    needsConfirmation: over.needsConfirmation ?? false
  }
}

/** Un message de 16 000 octets exactement (la limite d'un message côté worker), en paragraphes lisibles. */
function hugeText(index: number): string {
  const paragraph = `Paragraph of message ${index}: the quick brown fox jumps over the lazy dog, again and again.\n\n`
  let body = ''
  while (body.length + paragraph.length <= 16_000) body += paragraph
  return body.padEnd(16_000, '.')
}

/** Le formulaire de création, ouvert et vierge (rien n'y est persisté ; le check ne sait pas cliquer). */
function newSessionScenario() {
  const options: CreateFormOptions = {
    agents: [
      { kind: 'agent', id: 'agent_check', name: 'Writer', summary: 'v4 · claude-haiku-5-5' },
      { kind: 'agent', id: 'agent_other', name: 'Reviewer', summary: 'v1 · claude-sonnet-5' }
    ],
    environments: [{ kind: 'environment', id: 'env_check', name: 'Sandbox', summary: 'cloud' }],
    vaults: [{ kind: 'vault', id: 'vlt_check', name: 'GitHub', summary: '1 credential' }],
    memoryStores: [{ kind: 'memory_store', id: 'memstore_check', name: 'Notes', summary: '4 memories' }]
  }
  return {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'newSession' }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [] },
      'createForm.options': { ok: true as const, value: options }
    }
  }
}

/** Le formulaire de création d'un environnement, ouvert et vierge. */
function newEnvironmentScenario() {
  return {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'environment' }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [] }
    }
  }
}

/** Un environnement en réseau limité ; `draft` : sa description modifiée puis gardée (atome persisté) sur une version plus ancienne. */
function environmentDraftScenario(draft = true) {
  const form: EnvironmentForm = {
    name: 'Sandbox',
    description: 'Runs the nightly checks.',
    hosting: 'cloud',
    network: { mode: 'limited', allowedHosts: ['pypi.org', 'github.com'], allowPackageManagers: true, allowMcpServers: false },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: ['requests'] },
    metadata: [{ key: 'team', value: 'infra' }]
  }
  const detail: EnvironmentDetail = {
    kind: 'environment',
    id: 'env_check',
    name: 'Sandbox',
    description: form.description,
    updatedAt: '2026-11-22T10:00:00Z',
    form,
    hosting: 'cloud',
    network: form.network,
    packages: [{ key: 'pip', value: 'requests' }],
    metadata: form.metadata
  }
  const scenario = configScenario('environment', detail)
  if (!draft) return scenario
  return {
    ...scenario,
    persisted: {
      plugin: {
        ...scenario.persisted.plugin,
        // Commencée sur une version plus ancienne que le détail (`updatedAt` 10:00) : l'avis de conflit s'affiche.
        'forms.drafts': {
          'environment:env_check': {
            form: { ...form, description: 'Runs the nightly checks and the weekly audit.' },
            base: form,
            baseStamp: '2026-11-21T09:00:00Z'
          }
        }
      }
    }
  }
}

/** L'écran d'une banque : ses mémoires, et les lignes à envoyer que le panneau a gardées (atome persisté `memory.uploads`). */
function memoryStoreScenario(memories: MemoryStoreDetail['memories'], uploads: unknown[] = []) {
  const detail: MemoryStoreDetail = {
    kind: 'memory_store',
    id: 'memstore_check',
    name: 'Notes',
    description: 'Runbooks of the team.',
    updatedAt: '2026-11-21T10:00:00Z',
    form: { name: 'Notes', description: 'Runbooks of the team.' },
    memories
  }
  const scenario = configScenario('memory_store', detail)
  return {
    ...scenario,
    persisted: {
      plugin: {
        ...scenario.persisted.plugin,
        ...(uploads.length > 0 && { 'memory.uploads': { memstore_check: uploads } })
      }
    },
    requests: { ...scenario.requests, ...NO_DRAFTS }
  }
}


/** Une banque, avec une saisie gardée sur une version plus ancienne que le détail. */
function memoryStoreFormScenario() {
  const detail: MemoryStoreDetail = {
    kind: 'memory_store',
    id: 'memstore_check',
    name: 'Notes',
    description: 'Runbooks of the team.',
    updatedAt: '2026-11-21T10:00:00Z',
    form: { name: 'Notes', description: 'Runbooks of the team.' },
    memories: [
      { id: 'mem_a', path: '/runbooks/deploy.md', sizeBytes: 2048, updatedAt: '2026-11-20T10:00:00Z' },
      { id: 'mem_b', path: '/runbooks/rollback.md', sizeBytes: 300, updatedAt: '2026-11-21T10:00:00Z' }
    ]
  }
  const scenario = configScenario('memory_store', detail)
  return {
    ...scenario,
    persisted: {
      plugin: {
        ...scenario.persisted.plugin,
        'forms.drafts': {
          'memory_store:memstore_check': {
            form: { name: 'Notes', description: 'Runbooks of the team and the on-call rota.' },
            base: detail.form,
            baseStamp: '2026-11-20T09:00:00Z'
          }
        }
      }
    },
    requests: { ...scenario.requests, ...NO_DRAFTS }
  }
}

/** Un coffre avec un identifiant à jeton, une variable d'environnement et un OAuth ; le formulaire de `credentialId` est ouvert. */
function credentialScenario(credentialId: string | null) {
  const bearer: CredentialForm = { type: 'static_bearer', name: 'GitHub bearer', mcpServerUrl: 'https://api.githubcopilot.com/mcp/', token: '' }
  const variable: CredentialForm = {
    type: 'environment_variable',
    name: 'Deploy token',
    secretName: 'DEPLOY_TOKEN',
    secretValue: '',
    network: { mode: 'limited', allowedHosts: ['example.com', 'api.example.com'] },
    injection: { header: true, body: false }
  }
  const detail: ConfigDetail = {
    kind: 'vault',
    id: 'vlt_check',
    name: 'GitHub',
    updatedAt: '2026-11-22T10:00:00Z',
    form: { name: 'GitHub' },
    credentials: [
      { id: 'vcrd_bearer', name: 'GitHub bearer', type: 'static_bearer', mcpServerUrl: 'https://api.githubcopilot.com/mcp/', expiresAt: null, updatedAt: '2026-11-22T10:00:00Z', form: bearer },
      { id: 'vcrd_variable', name: 'Deploy token', type: 'environment_variable', mcpServerUrl: null, expiresAt: null, updatedAt: '2026-11-22T10:00:00Z', form: variable },
      { id: 'vcrd_oauth', name: 'GitHub OAuth', type: 'mcp_oauth', mcpServerUrl: 'https://api.githubcopilot.com/mcp/', expiresAt: '2027-01-01T00:00:00Z', updatedAt: '2026-11-22T10:00:00Z', form: null }
    ]
  }
  const scenario = configScenario('vault', detail)
  return {
    ...scenario,
    persisted: {
      plugin: {
        nav: [{ view: 'home' }, { view: 'config', kind: 'vault', id: detail.id }, { view: 'credential', vaultId: detail.id, credentialId }]
      }
    }
  }
}

/** Le détail d'un agent ouvert, avec en option une saisie gardée commencée sur une version plus ancienne. */
function agentScenario(options: { unsaved?: boolean } = {}) {
  const detail: AgentDetail = {
    kind: 'agent',
    id: 'agent_check',
    name: 'Incident commander',
    version: 5,
    form: AGENT_FORM,
    model: 'claude-haiku-5-5',
    effort: 'high',
    description: 'Triages incidents.',
    system: { text: 'You are an incident commander.\n\nBe brief and cite your sources.', truncated: true },
    builtinTools: { enabled: true, policy: 'always_allow', overrides: [{ name: 'web_search', enabled: false, policy: null }] },
    mcpServers: [
      {
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        policy: 'always_ask',
        overrides: [{ name: 'list_commits', enabled: true, policy: 'always_allow' }]
      },
      { name: 'linear', url: 'https://mcp.linear.app/mcp', enabled: true, policy: 'always_allow', overrides: [] }
    ],
    multiagent: 'Multiagent: advisor claude-opus-5, subagents (2 predefined)',
    multiagentCoordinator: false
  }
  const scenario = configScenario('agent', detail)
  return {
    persisted: {
      plugin: {
        ...scenario.persisted.plugin,
        ...(options.unsaved
          ? {
              'forms.drafts': {
                'agent:agent_check': {
                  form: { ...AGENT_FORM, description: 'Triages incidents and coordinates the response.', effort: 'medium' },
                  base: AGENT_FORM,
                  baseStamp: 3
                }
              }
            }
          : {})
      }
    },
    requests: { ...scenario.requests, ...AGENT_READS }
  }
}

/** Le formulaire de création d'un agent. */
function newAgentScenario() {
  return {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'agent' }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [] },
      ...AGENT_READS
    }
  }
}

/** Le détail d'une configuration, ouvert depuis l'accueil (pile persistée) ; l'API est remplacée par des réponses figées. */
function configScenario(kind: ConfigKind, detail: ConfigDetail) {
  return {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'config', kind, id: detail.id }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'sessions.list': { ok: true as const, value: [] },
      'configs.list': { ok: true as const, value: [] },
      'configs.detail': { ok: true as const, value: detail }
    }
  }
}

/** L'accueil avec le bloc Drafts : deux projets d'Orca candidats, le premier retenu ou aucun. */
function draftsSectionScenario(chosen: boolean) {
  return {
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [] },
      'drafts.projects': {
        ok: true as const,
        value: [
          { id: 'p_alpha', name: 'alpha', path: '/Users/someone/dev/alpha', current: chosen },
          { id: 'p_beta', name: 'a-project-with-a-rather-long-folder-name', path: '/Users/someone/dev/a-project-with-a-rather-long-folder-name', current: false }
        ]
      }
    }
  }
}

/** Une mémoire ouverte depuis sa banque, avec l'état du dossier de brouillons et du brouillon que le worker connaît. */
function memoryDraftScenario(drafts: { ready: boolean; info: DraftInfo | null }) {
  return {
    persisted: {
      plugin: {
        nav: [
          { view: 'home' },
          { view: 'config', kind: 'memory_store', id: 'memstore_check' },
          { view: 'memory', memoryStoreId: 'memstore_check', memoryId: 'mem_a' }
        ]
      }
    },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: null },
      'sessions.list': { ok: true as const, value: [] },
      'configs.list': { ok: true as const, value: [] },
      'memory.read': {
        ok: true as const,
        value: {
          id: 'mem_a',
          memoryStoreId: 'memstore_check',
          path: '/runbooks/deploy.md',
          updatedAt: '2026-11-20T10:00:00Z',
          sha256: 'sha-check',
          content: { text: '# Deploy\n\nRun the script.', truncated: false }
        }
      },
      'drafts.status': { folder: '/Users/someone/.config/agent-claude-managed/managed-agents', ready: drafts.ready },
      'draft.state': { ok: true as const, value: drafts.info }
    }
  }
}

function sessionScenario(input: { row: SessionRow; rows: ThreadRow[] }) {
  const stream: StreamState = { sessionId: input.row.id, phase: 'open', since: 0, reconnects: 0, error: null }
  const detail: SessionDetail = {
    ...input.row,
    agentVersion: 4,
    environmentId: 'env_check',
    environmentName: 'Sandbox',
    vaultIds: ['vlt_check'],
    resources: [],
    createdAt: '2026-11-22T09:00:00Z'
  }
  return {
    persisted: { plugin: { nav: [{ view: 'home' }, { view: 'session', sessionId: input.row.id }] } },
    requests: {
      'workspace.info': WITH_KEY,
      'sessions.visibility': { bootId: 'boot-1', watching: input.row.id },
      'configs.list': { ok: true as const, value: [] },
      'sessions.list': { ok: true as const, value: [input.row] },
      'session.watch': { ok: true as const, value: { rows: input.rows, hasEarlier: false, stream } },
      'session.detail': { ok: true as const, value: detail },
      'session.leave': null
    }
  }
}
