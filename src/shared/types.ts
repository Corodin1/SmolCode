export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh';

export type InteractionMode = 'build' | 'plan';

export type ApprovalPolicy = 'read-only' | 'auto' | 'full-access';

export type VramScheduleMode = 'stage-batched' | 'cpu-pin-fast' | 'strict-role-split';

export type ThemeMode = 'light' | 'dark' | 'system';

export type ThemePreset =
  | 'obsidian'
  | 'midnight'
  | 'graphite'
  | 'alabaster'
  | 'warm-paper'
  | 'high-contrast';

export type AccentColor = 'default' | 'blue' | 'emerald' | 'violet' | 'amber' | 'rose';

export type UiDensity = 'compact' | 'comfortable' | 'spacious';

export type FontSizeScale = 'sm' | 'md' | 'lg';

export type GlassIntensity = 'off' | 'subtle' | 'rich';

export type CenterView = 'thread' | 'skills' | 'automations' | 'settings' | 'archived';

export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'models'
  | 'environments'
  | 'mcp'
  | 'voice'
  | 'shortcuts';

export type PreferredEditor =
  | 'auto'
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'explorer'
  | 'terminal';

export type ImageGenProvider = 'auto' | 'sd-cpp' | 'comfyui' | 'a1111' | 'ollama';

export type ImageGenSize = '512x512' | '768x768' | '1024x1024' | '1024x576' | '576x1024';

export interface GeneratedImageRecord {
  id: string;
  threadId: string;
  turnId: string;
  prompt: string;
  negativePrompt?: string;
  filePath: string;
  dataUrl?: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  model: string;
  backend: Exclude<ImageGenProvider, 'auto'>;
  durationMs: number;
  createdAt: number;
}

export interface LocalImageBackendStatus {
  sdCppPath: string | null;
  comfyUiUp: boolean;
  a1111Up: boolean;
  ollamaImageModels: string[];
}

export type ThreadStatus =
  | 'idle'
  | 'queued'
  | 'scouting'
  | 'thinking'
  | 'verifying'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'error';

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantizationLevel: string;
  capabilities: {
    tools: boolean;
    thinking: boolean;
    vision: boolean;
  };
  contextLength: number;
}

export interface LoadedOllamaModel {
  name: string;
  sizeVramBytes: number;
  sizeBytes: number;
}

export interface VramStatus {
  totalMb: number;
  freeMb: number;
  loadedModels: LoadedOllamaModel[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  collapsed?: boolean;
}

export interface ComposerChip {
  id: string;
  kind: 'file' | 'symbol' | 'comment' | 'image' | 'terminal' | 'skill';
  label: string;
  filePath?: string;
  symbolName?: string;
  skillName?: string;
  startLine?: number;
  endLine?: number;
  body?: string;
  mimeType?: string;
  dataBase64?: string;
}

export interface QueuedPromptItem {
  id: string;
  content: string;
  chips: ComposerChip[];
  createdAt: number;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  title: string;
  interactionMode: InteractionMode;
  mainModel: string;
  fastModel: string;
  effort: EffortLevel;
  approvalPolicy: ApprovalPolicy;
  draftText: string;
  draftChips: ComposerChip[];
  queuedPrompts: QueuedPromptItem[];
  status: ThreadStatus;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied';

export interface ToolCallLog {
  id: string;
  toolName: string;
  summary: string;
  argsPreview: string;
  resultPreview?: string;
  liveOutput?: string;
  status: ToolStatus;
  durationMs?: number;
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface StructuredPlan {
  id: string;
  title: string;
  summary: string;
  steps: PlanStep[];
  approved?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  id: string;
  question: string;
  options: QuestionOption[];
  allowCustom: boolean;
  multiSelect?: boolean;
}

export interface UserQuestionPrompt {
  id: string;
  question: string;
  options: QuestionOption[];
  allowCustom: boolean;
  multiSelect?: boolean;
  questions?: QuestionItem[];
  answer?: string[];
  answersByQuestion?: Record<string, string[]>;
}

export interface UndoDiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface UndoDiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  lines: UndoDiffLine[];
  truncated?: boolean;
}

export interface UndoPreviewResult {
  threadId: string;
  targetTurnId: string;
  rollbackStartTurnId: string;
  hasSnapshot: boolean;
  snapshotId: string | null;
  restoredPrompt: string;
  restoredChips: ComposerChip[];
  turnsToRemoveCount: number;
  fileChanges: UndoDiffFile[];
}

export interface UndoExecutionResult {
  threadId: string;
  redoId: string;
  restoredPrompt: string;
  restoredChips: ComposerChip[];
  restoredFiles: string[];
  removedFiles: string[];
  turnsRemoved: number;
}

export interface WorkingMemoryLedger {
  goal: string;
  inspectedSymbols: string[];
  modifiedFiles: string[];
  activeErrors: string[];
  verifiedChecks: string[];
}

export interface TelemetrySnapshot {
  kvCacheHitRate: number;
  kvPrefixReused: boolean;
  kvPrefixTokens: number;
  promptEvalTokens: number;
  promptEvalMs: number;
  evalTokens: number;
  evalTokensPerSec: number;
  tokensSavedByAst: number;
  tokensSavedByHashline: number;
  tokensSavedByFolding: number;
  activeContextTokens: number;
  contextBudget: number;
  stageTimingsMs: {
    prefetch: number;
    scout: number;
    think: number;
    verify: number;
  };
  fastModelUsed: string;
  mainModelUsed: string;
}

export interface TurnRecord {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  chips?: ComposerChip[];
  thinking?: string;
  toolCalls?: ToolCallLog[];
  plan?: StructuredPlan;
  questionPrompt?: UserQuestionPrompt;
  ledger?: WorkingMemoryLedger;
  telemetry?: TelemetrySnapshot;
  generatedImages?: GeneratedImageRecord[];
  snapshotId?: string | null;
  createdAt: number;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  kind: 'command' | 'write_outside_root' | 'mcp_tool' | 'save_global_skill';
  title: string;
  commandOrPath: string;
  cwd: string;
  reason: string;
}

export type ApprovalDecision = 'allow-once' | 'allow-session' | 'deny';

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  scope: 'repo' | 'global' | 'builtin';
  content: string;
  tags?: string[];
  companionFiles?: string[];
}

export interface AutomationRule {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  cronExpr: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: 'idle' | 'running' | 'ok' | 'error';
  lastThreadId: string | null;
}

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  lastStatus?: 'idle' | 'ok' | 'error';
  lastError?: string;
  tools?: McpToolSummary[];
}

export interface ProjectEnvironment {
  projectId: string;
  setupScript: string;
  envVarsJson: string;
}

export interface AppSettings {
  ollamaBaseUrl: string;
  vramScheduleMode: VramScheduleMode;
  pinFastToCpu: boolean;
  theme: ThemeMode;
  themePreset: ThemePreset;
  accentColor: AccentColor;
  uiDensity: UiDensity;
  fontSize: FontSizeScale;
  glassIntensity: GlassIntensity;
  reduceMotion: boolean;
  defaultMainModel: string;
  defaultFastModel: string;
  defaultEffort: EffortLevel;
  defaultApprovalPolicy: ApprovalPolicy;
  defaultShell: 'auto' | 'pwsh' | 'powershell' | 'git-bash' | 'wsl';
  preferredEditor: PreferredEditor;
  notifyOnComplete: boolean;
  soundOnComplete: boolean;
  sttEndpointUrl: string;
  sttModel: string;
  showAdvancedDualModel: boolean;
  webLookupEnabled: boolean;
  obscuraPath: string;
  imageGenProvider: ImageGenProvider;
  sdCppPath: string;
  sdCppModelPath: string;
  sdCppVaePath: string;
  sdCppExtraArgs: string;
  imageGenLocalUrl: string;
  ollamaImageModel: string;
  imageGenDefaultSize: ImageGenSize;
  imageGenUnloadOllama: boolean;
}

export interface SearchSuggestion {
  kind: 'file' | 'symbol';
  label: string;
  filePath: string;
  symbolName?: string;
  startLine?: number;
  endLine?: number;
}

export type AgentStreamEvent =
  | { type: 'thread_status'; threadId: string; status: ThreadStatus }
  | { type: 'thread_updated'; thread: ThreadRecord }
  | { type: 'turn_created'; threadId: string; turn: TurnRecord }
  | { type: 'thinking_delta'; threadId: string; turnId: string; delta: string }
  | { type: 'content_delta'; threadId: string; turnId: string; delta: string }
  | { type: 'tool_update'; threadId: string; turnId: string; tool: ToolCallLog }
  | { type: 'plan_proposed'; threadId: string; turnId: string; plan: StructuredPlan }
  | { type: 'plan_updated'; threadId: string; turnId: string; plan: StructuredPlan }
  | { type: 'skills_updated'; projectId?: string; skills: SkillEntry[] }
  | {
      type: 'question_requested';
      threadId: string;
      turnId: string;
      prompt: UserQuestionPrompt;
    }
  | { type: 'approval_requested'; request: ApprovalRequest }
  | { type: 'turn_completed'; threadId: string; turn: TurnRecord; threadTitle?: string }
  | { type: 'turn_error'; threadId: string; turnId: string; message: string }
  | { type: 'image_generated'; threadId: string; turnId: string; image: GeneratedImageRecord }
  | { type: 'queue_updated'; activeThreadId: string | null; queuedThreadIds: string[] };

export interface SmolCodeApi {
  // System & Inference
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listOllamaModels(): Promise<OllamaModelInfo[]>;
  getVramStatus(): Promise<VramStatus>;
  openInEditor(
    targetPath: string,
    editor: PreferredEditor,
  ): Promise<{ ok: boolean; message?: string }>;
  toggleMiniWindow(mini: boolean): Promise<boolean>;
  showDesktopNotification(title: string, body: string): Promise<void>;
  transcribeAudio(
    audioBase64: string,
    mimeType: string,
  ): Promise<{ ok: boolean; text?: string; error?: string }>;

  // Projects & Threads
  listProjects(): Promise<ProjectRecord[]>;
  pickProjectFolder(): Promise<ProjectRecord | null>;
  addProject(rootPath: string): Promise<ProjectRecord>;
  removeProject(projectId: string): Promise<void>;
  setProjectCollapsed(projectId: string, collapsed: boolean): Promise<void>;

  listThreads(projectId?: string): Promise<ThreadRecord[]>;
  createThread(input: {
    projectId: string;
    interactionMode?: InteractionMode;
    mainModel?: string;
    fastModel?: string;
    effort?: EffortLevel;
    approvalPolicy?: ApprovalPolicy;
  }): Promise<ThreadRecord>;
  updateThread(threadId: string, patch: Partial<ThreadRecord>): Promise<ThreadRecord>;
  deleteThread(threadId: string): Promise<void>;
  listTurns(threadId: string): Promise<TurnRecord[]>;

  // Agent Execution, Planning, Steering & Queueing
  sendPrompt(input: {
    threadId: string;
    content: string;
    chips?: ComposerChip[];
  }): Promise<void>;
  steerThread(input: {
    threadId: string;
    content: string;
    chips?: ComposerChip[];
  }): Promise<void>;
  enqueuePrompt(input: {
    threadId: string;
    content: string;
    chips?: ComposerChip[];
  }): Promise<ThreadRecord>;
  removeQueuedPrompt(threadId: string, queueId: string): Promise<ThreadRecord>;
  stopThread(threadId: string): Promise<void>;
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  answerQuestionPrompt(
    threadId: string,
    turnId: string,
    promptId: string,
    answers: string[],
    answersByQuestion?: Record<string, string[]>,
  ): Promise<void>;
  approvePlanAndBuild(threadId: string, turnId: string): Promise<void>;
  compactThread(threadId: string): Promise<void>;
  previewUndoToTurn(threadId: string, turnId: string): Promise<UndoPreviewResult>;
  restoreTurnSnapshot(
    threadId: string,
    turnId: string,
  ): Promise<UndoExecutionResult>;
  revertUndoRollback(
    threadId: string,
    redoId: string,
  ): Promise<{ restoredFiles: string[]; removedFiles: string[]; turnsRestored: number }>;
  forkThreadFromTurn(threadId: string, turnId: string): Promise<ThreadRecord>;
  searchSymbolsAndFiles(
    projectId: string,
    query: string,
  ): Promise<SearchSuggestion[]>;
  readFileSlice(
    projectId: string,
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<{
    absPath: string;
    relPath: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    lines: Array<{ line: number; text: string }>;
  }>;
  pickAttachmentFiles(projectId: string): Promise<ComposerChip[]>;

  // Skills, Automations, Environments & MCP
  listSkills(projectId?: string): Promise<SkillEntry[]>;
  createSkill(input: {
    projectId?: string;
    scope: 'repo' | 'global';
    name: string;
    description: string;
    content: string;
    tags?: string[];
    companionFiles?: Array<{ path: string; content: string }>;
  }): Promise<SkillEntry>;
  updateSkill(input: {
    projectId?: string;
    scope: 'repo' | 'global';
    name: string;
    description: string;
    content: string;
    tags?: string[];
    companionFiles?: Array<{ path: string; content: string }>;
  }): Promise<SkillEntry>;
  deleteSkill(sourcePath: string, projectId?: string): Promise<void>;
  readSkillResource(sourcePath: string, relFile: string): Promise<string>;
  listAutomations(projectId?: string): Promise<AutomationRule[]>;
  saveAutomation(
    rule: Partial<AutomationRule> & { projectId: string },
  ): Promise<AutomationRule>;
  deleteAutomation(id: string): Promise<void>;
  runAutomationNow(id: string): Promise<void>;
  getProjectEnvironment(projectId: string): Promise<ProjectEnvironment>;
  saveProjectEnvironment(env: ProjectEnvironment): Promise<ProjectEnvironment>;
  listMcpServers(): Promise<McpServerConfig[]>;
  saveMcpServer(
    server: Partial<McpServerConfig> & { name: string },
  ): Promise<McpServerConfig>;
  deleteMcpServer(id: string): Promise<void>;
  testMcpServer(id: string): Promise<McpServerConfig>;

  // Terminal PTY
  spawnTerminal(input: {
    threadId: string;
    cols: number;
    rows: number;
    shellPref?: AppSettings['defaultShell'];
  }): Promise<{ ptyId: string; cwd: string; shell: string }>;
  writeTerminal(ptyId: string, data: string): Promise<void>;
  resizeTerminal(ptyId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(ptyId: string): Promise<void>;

  // Image Generation
  readGeneratedImageDataUrl(filePath: string): Promise<string>;
  saveGeneratedImageToWorkspace(input: {
    projectId: string;
    sourcePath: string;
    targetRelPath?: string;
  }): Promise<{ savedRelPath: string; absPath: string }>;
  copyGeneratedImageToClipboard(filePath: string): Promise<boolean>;
  detectLocalImageBackends(): Promise<LocalImageBackendStatus>;

  // Subscriptions
  onAgentEvent(cb: (event: AgentStreamEvent) => void): () => void;
  onTerminalData(cb: (payload: { ptyId: string; data: string }) => void): () => void;
  onTerminalExit(cb: (payload: { ptyId: string; code: number }) => void): () => void;
}
