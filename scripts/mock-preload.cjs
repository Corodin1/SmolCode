const { contextBridge } = require('electron');

const MOCK_SETTINGS = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  vramScheduleMode: 'stage-batched',
  pinFastToCpu: false,
  theme: 'dark',
  themePreset: 'obsidian',
  accentColor: 'blue',
  uiDensity: 'comfortable',
  fontSize: 'md',
  glassIntensity: 'subtle',
  reduceMotion: false,
  defaultMainModel: 'qwen2.5-coder:14b',
  defaultFastModel: 'qwen2.5-coder:1.5b',
  defaultEffort: 'medium',
  defaultApprovalPolicy: 'auto',
  defaultShell: 'auto',
  preferredEditor: 'vscode',
  notifyOnComplete: true,
  soundOnComplete: true,
  sttEndpointUrl: '',
  sttModel: 'whisper-1',
  showAdvancedDualModel: false,
  webLookupEnabled: true,
  obscuraPath: '',
};

const MOCK_PROJECTS = [
  {
    id: 'proj-smolcode',
    name: 'SmolCode',
    rootPath: 'C:\\coding Q4 2026\\SmolCode',
    createdAt: Date.now() - 86400000,
    collapsed: false,
  },
];

const MOCK_THREADS = [
  {
    id: 'th-ast-packer',
    projectId: 'proj-smolcode',
    title: 'Optimize AST Repo-Map token packer',
    interactionMode: 'build',
    mainModel: 'qwen2.5-coder:14b',
    fastModel: 'qwen2.5-coder:1.5b',
    effort: 'medium',
    approvalPolicy: 'auto',
    draftText: 'Verify tree-sitter symbol hierarchy and run typecheck',
    draftChips: [
      { id: 'c1', kind: 'file', label: 'ast-repo-map.ts', filePath: 'electron/intel/ast-repo-map.ts' },
      { id: 'c2', kind: 'symbol', label: 'buildImmutableZoneAPrefix', symbolName: 'buildImmutableZoneAPrefix' }
    ],
    queuedPrompts: [],
    status: 'idle',
    unread: false,
    pinned: true,
    archived: false,
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 60000,
  },
  {
    id: 'th-vram-scheduler',
    projectId: 'proj-smolcode',
    title: 'Stage-batched VRAM scheduler rules',
    interactionMode: 'plan',
    mainModel: 'deepseek-r1:14b',
    fastModel: 'qwen2.5-coder:1.5b',
    effort: 'high',
    approvalPolicy: 'read-only',
    draftText: '',
    draftChips: [],
    queuedPrompts: [],
    status: 'idle',
    unread: false,
    pinned: false,
    archived: false,
    createdAt: Date.now() - 7200000,
    updatedAt: Date.now() - 1800000,
  },
  {
    id: 'th-mcp-integration',
    projectId: 'proj-smolcode',
    title: 'Model Context Protocol stdio transport',
    interactionMode: 'build',
    mainModel: 'qwen2.5-coder:7b',
    fastModel: '',
    effort: 'low',
    approvalPolicy: 'auto',
    draftText: '',
    draftChips: [],
    queuedPrompts: [],
    status: 'idle',
    unread: false,
    pinned: false,
    archived: false,
    createdAt: Date.now() - 14400000,
    updatedAt: Date.now() - 7200000,
  },
];

const MOCK_TURNS = [
  {
    id: 'turn-1',
    threadId: 'th-ast-packer',
    role: 'user',
    content: 'Refactor `electron/intel/ast-repo-map.ts` to rank definitions by PageRank centrality and pack them into Zone A for KV cache reuse.',
    chips: [
      { id: 'uc1', kind: 'file', label: 'ast-repo-map.ts', filePath: 'electron/intel/ast-repo-map.ts' }
    ],
    thinking: null,
    toolCalls: [],
    plan: null,
    questionPrompt: null,
    approvalRequest: null,
    telemetry: null,
    createdAt: Date.now() - 300000,
    status: 'done',
  },
  {
    id: 'turn-2',
    threadId: 'th-ast-packer',
    role: 'assistant',
    content: 'I have inspected the symbol dependency graph across `electron/intel/`. The tree-sitter AST nodes indicate 14 primary symbol definitions. Applying in-degree centrality allows packing top symbols into Zone A with deterministic ordering, ensuring KV prefix cache stability.',
    chips: [],
    thinking: 'Inspected symbol graph and caller matrix. Tree-sitter AST nodes indicate 14 primary symbol definitions across 8 files.\nNeed to preserve KV cache prefix stability in Zone A by keeping symbol order deterministic.\nApplying PageRank-style in-degree centrality ranking:\n1. buildImmutableZoneAPrefix\n2. TreeSitterService.extractSymbols\n3. calculateFileDigest\nAll edits validated with hashline line-precise anchors.',
    toolCalls: [
      {
        id: 'tc-1',
        name: 'search_symbols',
        summary: 'Find symbol definitions for TreeSitterService in electron/intel/',
        status: 'done',
        liveOutput: 'Found 6 matches in tree-sitter-service.ts and ast-repo-map.ts',
        startedAt: Date.now() - 250000,
        endedAt: Date.now() - 248000,
      },
      {
        id: 'tc-2',
        name: 'read_symbol',
        summary: 'Read ast-repo-map.ts :: rankSymbolsByCentrality',
        status: 'done',
        liveOutput: 'Lines 42-88 read with hashline anchors (SHA-256 integrity verified)',
        startedAt: Date.now() - 245000,
        endedAt: Date.now() - 242000,
      },
      {
        id: 'tc-3',
        name: 'patch_hashline',
        summary: 'Apply line-anchored patch to electron/intel/ast-repo-map.ts',
        status: 'done',
        liveOutput: 'Applied 1 hunk cleanly (24 lines replaced, 0 conflicts)',
        startedAt: Date.now() - 240000,
        endedAt: Date.now() - 238000,
      }
    ],
    plan: {
      id: 'plan-1',
      title: 'AST Repo-Map Centrality Optimization',
      steps: [
        { id: 's1', title: 'Extract AST symbol definitions with Web-Tree-Sitter', status: 'done' },
        { id: 's2', title: 'Compute in-degree PageRank centrality score', status: 'done' },
        { id: 's3', title: 'Format line-anchored hashline patches for Zone A', status: 'in_progress' },
        { id: 's4', title: 'Verify full test suite under Vitest', status: 'pending' },
      ],
      createdAt: Date.now() - 280000,
    },
    questionPrompt: null,
    approvalRequest: null,
    telemetry: {
      kvCacheHitRate: 0.88,
      kvPrefixReused: true,
      kvPrefixTokens: 2450,
      promptEvalTokens: 4120,
      promptEvalMs: 310,
      evalTokens: 846,
      evalTokensPerSec: 48.2,
      tokensSavedByAst: 1240,
      tokensSavedByHashline: 580,
      tokensSavedByFolding: 320,
      activeContextTokens: 4966,
      contextBudget: 32768,
      stageTimingsMs: {
        prefetch: 45,
        scout: 220,
        think: 1450,
        verify: 310,
      },
      fastModelUsed: 'qwen2.5-coder:1.5b',
      mainModelUsed: 'qwen2.5-coder:14b',
    },
    createdAt: Date.now() - 290000,
    status: 'done',
  }
];

const MOCK_MODELS = [
  {
    name: 'qwen2.5-coder:7b',
    sizeBytes: 4680000000,
    parameterSize: '7.6B',
    quantizationLevel: 'Q4_K_M',
    capabilities: { tools: true, thinking: true, vision: false },
    contextLength: 32768,
  },
  {
    name: 'qwen2.5-coder:14b',
    sizeBytes: 9240000000,
    parameterSize: '14.7B',
    quantizationLevel: 'Q4_K_M',
    capabilities: { tools: true, thinking: true, vision: false },
    contextLength: 65536,
  },
  {
    name: 'deepseek-r1:14b',
    sizeBytes: 9450000000,
    parameterSize: '14B',
    quantizationLevel: 'Q4_K_M',
    capabilities: { tools: true, thinking: true, vision: false },
    contextLength: 65536,
  },
  {
    name: 'qwen2.5-coder:1.5b',
    sizeBytes: 1100000000,
    parameterSize: '1.5B',
    quantizationLevel: 'Q4_K_M',
    capabilities: { tools: true, thinking: false, vision: false },
    contextLength: 32768,
  },
];

const MOCK_VRAM = {
  totalMb: 16384,
  freeMb: 9412,
  loadedModels: [
    {
      name: 'qwen2.5-coder:14b',
      sizeBytes: 9240000000,
      sizeVramBytes: 7311000000,
    }
  ],
};

const MOCK_SKILLS = [
  {
    name: 'smolcode-architecture',
    description: 'Modify SmolCode Electron IPC channels, preload bridge, SQLite migrations, or Git-free SnapshotManager state safely.',
    tags: ['smolcode', 'electron', 'ipc', 'sqlite'],
    sourcePath: '.smolcode/skills/smolcode-architecture/SKILL.md',
    scope: 'workspace',
  },
  {
    name: 'smolcode-agent-tools',
    description: 'Extend SmolCode 4-stage AgentOrchestrator, tool registry, LoopGuard, Zone A KV cache, or MCP pooling.',
    tags: ['smolcode', 'agent', 'tools', 'ollama', 'mcp'],
    sourcePath: '.smolcode/skills/smolcode-agent-tools/SKILL.md',
    scope: 'workspace',
  },
  {
    name: 'smolcode-testing',
    description: 'Write and run Vitest unit, integration, and jsdom UI tests plus full typecheck/lint/build verification for SmolCode.',
    tags: ['smolcode', 'testing', 'vitest'],
    sourcePath: '.smolcode/skills/smolcode-testing/SKILL.md',
    scope: 'workspace',
  },
  {
    name: 'smolcode-ui-tokens',
    description: 'Build or restyle SmolCode React UI components, CSS tokens, motion animations, and ThreadView virtualization.',
    tags: ['smolcode', 'ui', 'css', 'react'],
    sourcePath: '.smolcode/skills/smolcode-ui-tokens/SKILL.md',
    scope: 'workspace',
  },
];

const MOCK_MCP = [
  {
    id: 'mcp-sqlite',
    name: 'SQLite Database Inspector',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-sqlite --db .smolcode/smolcode.db',
    enabled: true,
  },
  {
    id: 'mcp-fetch',
    name: 'Obscura Web Fetcher',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-fetch',
    enabled: true,
  },
];

const listeners = new Set();

const mockApi = {
  getSettings: async () => MOCK_SETTINGS,
  updateSettings: async (patch) => Object.assign(MOCK_SETTINGS, patch),
  listOllamaModels: async () => MOCK_MODELS,
  getVramStatus: async () => MOCK_VRAM,
  openInEditor: async () => {},
  toggleMiniWindow: async () => {},
  showDesktopNotification: async () => {},
  transcribeAudio: async () => 'test transcription',

  listProjects: async () => MOCK_PROJECTS,
  pickProjectFolder: async () => MOCK_PROJECTS[0],
  addProject: async () => MOCK_PROJECTS[0],
  removeProject: async () => {},
  setProjectCollapsed: async () => {},

  listThreads: async () => MOCK_THREADS,
  createThread: async (input) => ({
    ...MOCK_THREADS[0],
    id: 'th-new',
    title: 'New Thread',
  }),
  updateThread: async (threadId, patch) => {
    const t = MOCK_THREADS.find(x => x.id === threadId) || MOCK_THREADS[0];
    return Object.assign(t, patch);
  },
  deleteThread: async () => {},
  listTurns: async () => MOCK_TURNS,

  sendPrompt: async () => {},
  steerThread: async () => {},
  enqueuePrompt: async () => {},
  removeQueuedPrompt: async () => {},
  stopThread: async () => {},
  resolveApproval: async () => {},
  answerQuestionPrompt: async () => {},
  approvePlanAndBuild: async () => {},
  compactThread: async () => {},
  previewUndoToTurn: async () => ({ diffSummary: '', filesChanged: [] }),
  restoreTurnSnapshot: async () => ({ restoredCount: 0 }),
  revertUndoRollback: async () => ({ restoredCount: 0 }),
  forkThreadFromTurn: async () => MOCK_THREADS[0],
  searchSymbolsAndFiles: async () => [],
  readFileSlice: async () => 'content slice',
  pickAttachmentFiles: async () => [],

  listSkills: async () => MOCK_SKILLS,
  createSkill: async () => MOCK_SKILLS[0],
  updateSkill: async () => MOCK_SKILLS[0],
  deleteSkill: async () => {},

  listAutomations: async () => [],
  saveAutomation: async (a) => a,
  deleteAutomation: async () => {},
  triggerAutomation: async () => {},

  listMcpServers: async () => MOCK_MCP,
  saveMcpServer: async (s) => s,
  deleteMcpServer: async () => {},
  testMcpServer: async () => ({ ok: true, tools: [{ name: 'read_query' }] }),

  onAgentEvent: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  ptySpawn: async () => 'pty-1',
  ptyWrite: () => {},
  ptyResize: () => {},
  ptyKill: () => {},
  onPtyData: () => () => {},
  onPtyExit: () => () => {},

  getProjectEnvironment: async () => ({
    projectId: 'proj-smolcode',
    setupScript: 'npm install',
    envVarsJson: '{"NODE_ENV":"development"}',
  }),
  saveProjectEnvironment: async () => {},
};

window.addEventListener('error', (e) => {
  console.error('WINDOW ERROR:', e.message, e.error?.stack);
});

contextBridge.exposeInMainWorld('smolcode', mockApi);
