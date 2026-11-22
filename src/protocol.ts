// Contrat panneau ↔ worker : déclaré une fois, lu par le panneau et par le worker.
// Aucun import du SDK ici : le panneau ne peut charger que `orca` et des fichiers relatifs.

/** Plafonds de rendu d'un panneau en composants Orca, avec marge (doc plugin-declarative-ui, Limits). */
export const MESSAGE_LIMIT_BYTES = 16_000
export const TOOL_IO_LIMIT_BYTES = 4_000
export const DETAIL_TEXT_LIMIT_BYTES = 60_000
export const THREAD_WINDOW_ROWS = 100
export const THREAD_WINDOW_BYTES = 384_000
export const POLL_VISIBLE_MS = 10_000
export const POLL_HIDDEN_MS = 60_000
export const DEFAULT_BUDGET_DOLLARS = '5.00'
/** Attente du panneau sur `session.create` (le plafond d'Orca) ; le délai du worker sur l'appel à l'API est plus court. */
export const SESSION_CREATE_WAIT_MS = 120_000

export type ApiErrorCode =
  | 'no_key'
  | 'unauthorized'
  | 'model_not_budgetable'
  | 'budget_not_raised'
  | 'budget_create_only'
  /** L'objet a changé depuis son ouverture : l'écriture est refusée, sauf si elle est forcée. */
  | 'conflict'
  /** Le formulaire est refusé avant tout appel réseau. */
  | 'invalid'
  | 'other'

/** Un appel à l'API Anthropic : une erreur revient en texte lisible, jamais en exception. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code: ApiErrorCode }

/** Un montant de l'API : entier en unités mineures, en chaîne (`"2500"` = 25,00). */
export type Money = { minor: string; currency: string }

export type ClippedText = { text: string; truncated: boolean }

export type WorkspaceInfo = {
  hasKey: boolean
  /** Vrai quand l'API a refusé la clé enregistrée (401) : le panneau remontre le formulaire. */
  keyRejected: boolean
  workspaceId: string | null
  organizationName: string | null
}

export type ConfigKind = 'agent' | 'environment' | 'memory_store' | 'vault'

export type ConfigRow = { kind: ConfigKind; id: string; name: string; summary: string }

export type ToolPolicy = 'always_allow' | 'always_ask' | 'auto'

export type ToolSetting = { name: string; enabled: boolean; policy: ToolPolicy | null }

export type ToolsetView = {
  enabled: boolean
  policy: ToolPolicy | null
  /** Outils réglés un par un (`configs`), seulement ceux qui existent dans l'agent. */
  overrides: ToolSetting[]
}

export type AgentDetail = {
  kind: 'agent'
  id: string
  name: string
  version: number
  model: string
  effort: string | null
  description: string | null
  system: ClippedText
  builtinTools: ToolsetView | null
  mcpServers: (ToolsetView & { name: string; url: string })[]
  skills: string[]
  /** Une ligne de résumé du bloc `multiagent`, ou null s'il n'y en a pas. */
  multiagent: string | null
}

export type KeyValueItem = { key: string; value: string }

/** Ordre d'affichage des gestionnaires de paquets d'un environnement. */
export const PACKAGE_MANAGERS = ['apt', 'cargo', 'gem', 'go', 'npm', 'pip'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]
export type PackageLists = Record<PackageManager, string[]>
export const ALLOWED_HOSTS_MAX = 16

export type EnvironmentNetworkForm =
  | { mode: 'unrestricted' }
  | { mode: 'limited'; allowedHosts: string[]; allowPackageManagers: boolean; allowMcpServers: boolean }

/** L'environnement tel que le formulaire le modifie. */
export type EnvironmentForm = {
  name: string
  description: string
  hosting: 'cloud' | 'self_hosted'
  /** Ignoré pour `self_hosted` : l'hôte gère le réseau et les paquets. */
  network: EnvironmentNetworkForm
  packages: PackageLists
  metadata: KeyValueItem[]
}

export type EnvironmentDetail = {
  kind: 'environment'
  id: string
  name: string
  description: string | null
  /** Horodatage de la dernière modification : sert à détecter un changement ailleurs avant d'écrire. */
  updatedAt: string
  form: EnvironmentForm
  hosting: string
  network:
    | { mode: 'unrestricted' }
    | { mode: 'limited'; allowedHosts: string[]; allowPackageManagers: boolean; allowMcpServers: boolean }
    /** Réseau géré par l'hôte d'un environnement `self_hosted` : l'API ne le décrit pas. */
    | { mode: 'host_managed' }
  packages: KeyValueItem[]
  metadata: KeyValueItem[]
}

export type MemoryRow = { id: string; path: string; sizeBytes: number; updatedAt: string }

export type MemoryStoreDetail = {
  kind: 'memory_store'
  id: string
  name: string
  description: string | null
  memories: MemoryRow[]
}

export type MemoryContent = { id: string; memoryStoreId: string; path: string; updatedAt: string; content: ClippedText }

export type CredentialType = 'mcp_oauth' | 'static_bearer' | 'environment_variable'

export type CredentialRow = {
  id: string
  name: string
  type: CredentialType
  mcpServerUrl: string | null
  expiresAt: string | null
}

export type VaultDetail = { kind: 'vault'; id: string; name: string; credentials: CredentialRow[] }

export type ConfigDetail = AgentDetail | EnvironmentDetail | MemoryStoreDetail | VaultDetail

export type SessionStatus = 'rescheduling' | 'running' | 'idle' | 'terminated'

export type SessionBadge =
  | 'needs_approval'
  | 'blocked'
  | 'budget_reached'
  | 'running'
  | 'rescheduling'
  | 'idle'
  | 'terminated'

export type SessionRow = {
  id: string
  title: string | null
  agentId: string
  agentName: string
  status: SessionStatus
  badge: SessionBadge
  cost: Money | null
  budget: Money | null
  updatedAt: string
  /** Appels d'outil en attente d'accord (`needs_approval` ou `blocked`) ; 0 sinon. */
  pendingApprovals: number
}

export type SessionDetail = SessionRow & {
  agentVersion: number
  environmentId: string
  environmentName: string | null
  vaultIds: string[]
  /** Une ligne lisible par ressource montée (dépôt, fichier, banque de mémoire). */
  resources: string[]
  createdAt: string
}

export type ToolState = 'awaiting_approval' | 'allowed' | 'denied' | 'running' | 'done' | 'error'

export type ThreadRow =
  | { id: string; at: string | null; kind: 'user_message' | 'agent_message'; text: ClippedText }
  | {
      id: string
      at: string | null
      kind: 'tool'
      name: string
      /** Nom du serveur MCP ; null pour un outil intégré ou personnalisé. */
      server: string | null
      input: ClippedText
      result: ClippedText | null
      state: ToolState
      /** Vrai tant que l'appel attend un `user.tool_confirmation`. */
      needsConfirmation: boolean
    }
  | { id: string; at: string | null; kind: 'status'; text: string; tone: 'neutral' | 'warning' | 'danger' }

/** Texte d'un message en cours d'écriture, remplacé par son `agent.message` définitif. */
export type Preview = { id: string; text: string }

export type StreamPhase = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type StreamState = {
  sessionId: string
  phase: StreamPhase
  since: number
  reconnects: number
  error: string | null
}

export type WatchAnswer = { rows: ThreadRow[]; hasEarlier: boolean; stream: StreamState }

/**
 * Réponse au ping de visibilité : `bootId` change à chaque activation du worker, `watching` est la
 * session que son suivi en direct porte (null si aucune). Le panneau s'en sert pour rouvrir le suivi
 * d'une vue ouverte après un redémarrage du worker.
 */
export type VisibilityAnswer = { bootId: string; watching: string | null }

export type SessionCreateInput = {
  agentId: string
  environmentId: string
  title: string | null
  vaultIds: string[]
  memoryStoreIds: string[]
  /** Dollars saisis (`"5.00"`), ou null pour une session sans plafond. */
  budgetDollars: string | null
  firstMessage: string | null
  /** Réservé aux sessions de test des agents d'exécution (`purpose: plugin-test`). */
  metadata?: Record<string, string>
}

/** `base` est le formulaire tel qu'il a été chargé ; null à la création. */
export type SaveInput<F> = { id: string | null; baseUpdatedAt: string | null; force: boolean; form: F; base: F | null }

export type Saved = { id: string; updatedAt: string }

/** Une ressource à archiver ou supprimer ; credentials et mémoires portent l'id de leur parent. */
export type ResourceRef =
  | { kind: 'agent' | 'environment' | 'vault' | 'memory_store' | 'session'; id: string }
  | { kind: 'credential'; vaultId: string; id: string }
  | { kind: 'memory'; memoryStoreId: string; id: string }

export type CreateFormOptions = {
  agents: ConfigRow[]
  environments: ConfigRow[]
  vaults: ConfigRow[]
  memoryStores: ConfigRow[]
}

declare module 'orca' {
  interface PluginRequests {
    'workspace.info': { output: WorkspaceInfo }
    'key.set': { input: { key: string }; output: ApiResult<WorkspaceInfo> }
    'key.clear': { output: WorkspaceInfo }
    'configs.list': { input: { kind: ConfigKind }; output: ApiResult<ConfigRow[]> }
    'configs.detail': { input: { kind: ConfigKind; id: string }; output: ApiResult<ConfigDetail> }
    'memory.read': { input: { memoryStoreId: string; memoryId: string }; output: ApiResult<MemoryContent> }
    'sessions.list': { output: ApiResult<SessionRow[]> }
    'sessions.visibility': { input: { visible: boolean }; output: VisibilityAnswer }
    'session.detail': { input: { sessionId: string }; output: ApiResult<SessionDetail> }
    'session.watch': { input: { sessionId: string }; output: ApiResult<WatchAnswer> }
    'session.leave': { input: { sessionId: string }; output: null }
    'session.loadEarlier': {
      input: { sessionId: string; beforeId: string }
      output: ApiResult<{ rows: ThreadRow[]; hasEarlier: boolean }>
    }
    'session.send': { input: { sessionId: string; text: string }; output: ApiResult<null> }
    'session.confirm': {
      input: { sessionId: string; toolUseId: string; allow: boolean; denyMessage: string | null }
      output: ApiResult<null>
    }
    'session.interrupt': { input: { sessionId: string }; output: ApiResult<null> }
    'session.create': { input: SessionCreateInput; output: ApiResult<{ sessionId: string }> }
    'session.raiseBudget': { input: { sessionId: string; dollars: string }; output: ApiResult<SessionDetail> }
    'environment.save': { input: SaveInput<EnvironmentForm>; output: ApiResult<Saved> }
    'resource.archive': { input: ResourceRef; output: ApiResult<null> }
    'resource.delete': { input: ResourceRef; output: ApiResult<null> }
    'createForm.options': { output: ApiResult<CreateFormOptions> }
    'diagnostics.testSpend': { output: ApiResult<{ sessions: number; total: Money | null }> }
  }
  interface PluginPanelEvents {
    'sessions.changed': { rows: SessionRow[] }
    'stream.state': StreamState
    /** Lignes nouvelles ou modifiées (à fusionner par `id`) et état complet des aperçus. */
    'session.thread': {
      sessionId: string
      rows: ThreadRow[]
      previews: Preview[]
      /** Présent sur le premier envoi de la relecture de l'historique : vrai quand le worker garde des lignes plus anciennes. */
      hasEarlier?: boolean
    }
    'session.updated': { sessionId: string; status: SessionStatus; badge: SessionBadge; cost: Money | null; budget: Money | null }
  }
}
