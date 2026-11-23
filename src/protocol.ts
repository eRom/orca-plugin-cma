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
  /** Le récapitulatif en attente n'existe plus (délai dépassé ou worker relancé) : il faut recommencer. */
  | 'expired'
  /** Le formulaire est refusé avant tout appel réseau. */
  | 'invalid'
  /** Le dossier de brouillons n'est pas un projet d'Orca : il faut l'y ajouter. */
  | 'drafts_missing'
  /** Le fichier de brouillon n'a pas changé depuis l'écriture du worker : rien à envoyer. */
  | 'nothing_to_apply'
  | 'other'

/** Un appel à l'API Anthropic : une erreur revient en texte lisible, jamais en exception. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code: ApiErrorCode }

/** Un montant de l'API : entier en unités mineures, en chaîne (`"2500"` = 25,00). */
export type Money = { minor: string; currency: string }

export type ClippedText = { text: string; truncated: boolean }

/** Un workspace associé, tel que la liste l'affiche. */
export type WorkspaceRow = { localId: string; name: string; workspaceId: string | null; active: boolean }

/** Les champs décrivent le workspace actif ; `workspaces` liste tous ceux qui sont associés (vide : aucun). */
export type WorkspaceInfo = {
  hasKey: boolean
  /** Vrai quand l'API a refusé la clé enregistrée (401) : le panneau remontre le formulaire. */
  keyRejected: boolean
  workspaceId: string | null
  organizationName: string | null
  workspaces: WorkspaceRow[]
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

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

/** Les outils intégrés d'un agent, dans l'ordre où le formulaire les propose. */
export const BUILTIN_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read', 'web_fetch', 'web_search', 'write'] as const

export type AgentToolsForm = {
  enabled: boolean
  policy: ToolPolicy
  /** Par outil : null = hérite du défaut du toolset (aucune entrée `configs` pour ce réglage). */
  tools: { name: (typeof BUILTIN_TOOLS)[number]; enabled: boolean | null; policy: ToolPolicy | null }[]
}

/** L'agent tel que le formulaire le modifie. */
export type AgentForm = {
  name: string
  model: string
  effort: AgentEffort | null
  description: string
  /** null : l'agent n'a pas de toolset intégré. */
  builtinTools: AgentToolsForm | null
  mcpServers: { name: string; url: string; policy: ToolPolicy }[]
}

export type AgentDetail = {
  kind: 'agent'
  id: string
  name: string
  version: number
  form: AgentForm
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

/** La banque telle que le formulaire la modifie. */
export type MemoryStoreForm = { name: string; description: string }

export type MemoryStoreDetail = {
  kind: 'memory_store'
  id: string
  name: string
  description: string | null
  /** Horodatage de la dernière modification : sert à détecter un changement ailleurs avant d'écrire. */
  updatedAt: string
  form: MemoryStoreForm
  memories: MemoryRow[]
}

export type MemoryContent = {
  id: string
  memoryStoreId: string
  path: string
  updatedAt: string
  /** Le `content_sha256` de l'API : la base d'un renommage, qui échoue si le contenu a changé entre-temps. */
  sha256: string
  content: ClippedText
}

/** Renommer une mémoire (changer son chemin) ; `baseSha256` est celui que le panneau a lu. */
export type MemoryRenameInput = { memoryStoreId: string; memoryId: string; path: string; baseSha256: string }

export type CredentialType = 'mcp_oauth' | 'static_bearer' | 'environment_variable'

export type VaultForm = { name: string }

export type CredentialNetworkForm = { mode: 'unrestricted' } | { mode: 'limited'; allowedHosts: string[] }

/**
 * L'identifiant tel que le formulaire le modifie. `token` et `secretValue` valent '' à la
 * modification (secret inchangé) ; ils sont obligatoires à la création. Le worker ne rend jamais un secret.
 */
export type CredentialForm =
  | { type: 'static_bearer'; name: string; mcpServerUrl: string; token: string }
  | {
      type: 'environment_variable'
      name: string
      secretName: string
      secretValue: string
      network: CredentialNetworkForm
      injection: { header: boolean; body: boolean }
    }

export type CredentialRow = {
  id: string
  name: string
  type: CredentialType
  mcpServerUrl: string | null
  expiresAt: string | null
  updatedAt: string
  /** Null pour `mcp_oauth` : ce type ne se modifie pas ici. Les secrets y sont toujours ''. */
  form: CredentialForm | null
}

export type VaultDetail = {
  kind: 'vault'
  id: string
  name: string
  /** Horodatage de la dernière modification : sert à détecter un changement ailleurs avant d'écrire. */
  updatedAt: string
  form: VaultForm
  credentials: CredentialRow[]
}

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

/** Un champ qui change entre l'état lu et l'état à écrire. */
export type FieldChange = {
  path: string
  /** Valeur abrégée à 200 octets ; null quand le champ n'existait pas. */
  before: string | null
  after: string | null
  /** Pour un texte long (plus de 200 octets ou plusieurs lignes) : lignes ajoutées et retirées. */
  lines: { added: number; removed: number } | null
}

/** Nombre maximal de changements rendus dans un récapitulatif ; `totalChanges` garde le compte réel. */
export const CHANGES_RENDER_CAP = 200

/** Une écriture mise en attente côté worker : le panneau la confirme avec `token`. */
export type PreparedWrite = { token: string; changes: FieldChange[]; totalChanges: number; creates: boolean }

/** Le résultat d'une écriture confirmée, en une étiquette lisible. */
export type Committed = {
  label: string
  /** L'id de l'objet écrit, quand l'appelant en a besoin (un agent créé depuis son YAML). */
  id?: string
}

/** Une ressource à archiver ou supprimer ; credentials et mémoires portent l'id de leur parent. */
export type ResourceRef =
  | { kind: 'agent' | 'environment' | 'vault' | 'memory_store' | 'session'; id: string }
  | { kind: 'credential'; vaultId: string; id: string }
  | { kind: 'memory'; memoryStoreId: string; id: string }

/** Un brouillon : un fichier du dossier de brouillons que Romain édite dans l'éditeur d'Orca. */
export type DraftRef =
  /** `agentId` null : nouvel agent, depuis le modèle. */
  | { kind: 'agent'; agentId: string | null }
  /** `memoryId` null : nouvelle mémoire à `path`. */
  | { kind: 'memory'; memoryStoreId: string; memoryId: string | null; path: string }

/** Un fichier choisi dans la boîte de dialogue du système : chemin absolu et nom de base. */
export type PickedFile = { file: string; name: string }

/** Une ligne d'envoi : `path` est le chemin de la mémoire, `memoryId` non nul pour remplacer une mémoire existante. */
export type UploadItem = { path: string; file: string; memoryId: string | null }

export type DraftsStatus = { folder: string; ready: boolean }

export type DraftInfo = {
  ref: DraftRef
  /** Chemin relatif au dossier de brouillons. */
  file: string
  /** Vrai quand le fichier diffère de ce que le worker y a écrit. */
  unapplied: boolean
  /** Heure de la dernière écriture du worker (ISO). */
  writtenAt: string
  /** Heure de modification du fichier sur disque (ISO) : celle de la dernière sauvegarde de Romain. */
  savedAt: string
  returnTo: { workspaceId: string; name: string } | null
}

export type CreateFormOptions = {
  agents: ConfigRow[]
  environments: ConfigRow[]
  vaults: ConfigRow[]
  memoryStores: ConfigRow[]
}

declare module 'orca' {
  interface PluginRequests {
    'workspace.info': { output: WorkspaceInfo }
    'workspaces.add': { input: { name: string; key: string }; output: ApiResult<WorkspaceInfo> }
    'workspaces.rename': { input: { localId: string; name: string }; output: ApiResult<WorkspaceInfo> }
    'workspaces.replaceKey': { input: { localId: string; key: string }; output: ApiResult<WorkspaceInfo> }
    'workspaces.remove': { input: { localId: string }; output: ApiResult<WorkspaceInfo> }
    'workspaces.activate': { input: { localId: string }; output: ApiResult<WorkspaceInfo> }
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
    'vault.save': { input: SaveInput<VaultForm>; output: ApiResult<Saved> }
    'memoryStore.save': { input: SaveInput<MemoryStoreForm>; output: ApiResult<Saved> }
    'memory.rename': { input: MemoryRenameInput; output: ApiResult<Saved> }
    'credential.save': { input: SaveInput<CredentialForm> & { vaultId: string }; output: ApiResult<Saved> }
    'resource.archive': { input: ResourceRef; output: ApiResult<null> }
    'resource.delete': { input: ResourceRef; output: ApiResult<null> }
    'write.commit': { input: { token: string; force: boolean }; output: ApiResult<Committed> }
    'createForm.options': { output: ApiResult<CreateFormOptions> }
    /** Les modèles que le formulaire d'agent propose ; vide si l'API ne les donne pas (le panneau ajoute le modèle courant). */
    'agent.formOptions': { output: ApiResult<{ models: string[] }> }
    /** `agentId` null : un nouvel agent. `baseVersion` et `base` sont ceux que le formulaire a ouverts. */
    'agent.prepareForm': {
      input: { agentId: string | null; baseVersion: number | null; form: AgentForm; base: AgentForm | null }
      output: ApiResult<PreparedWrite>
    }
    'drafts.status': { output: DraftsStatus }
    'draft.open': { input: DraftRef; output: ApiResult<DraftInfo> }
    'draft.discard': { input: DraftRef; output: ApiResult<DraftInfo> }
    'draft.state': { input: DraftRef; output: ApiResult<DraftInfo | null> }
    'draft.prepare': { input: DraftRef; output: ApiResult<PreparedWrite> }
    /** `null` : la boîte de dialogue a été annulée. */
    'file.pick': { output: ApiResult<PickedFile | null> }
    'memory.stageUploads': { input: { memoryStoreId: string; items: UploadItem[] }; output: ApiResult<PreparedWrite> }
    'workspace.back': { input: { workspaceId: string }; output: ApiResult<null> }
    'diagnostics.testSpend': { output: ApiResult<{ sessions: number; total: Money | null }> }
  }
  interface PluginPanelEvents {
    'sessions.changed': { rows: SessionRow[] }
    /** Le workspace actif a changé (bascule, retrait de l'actif, premier ajout) : l'état à jour, pour les panneaux qui n'ont pas fait la demande. */
    'workspace.changed': WorkspaceInfo
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
