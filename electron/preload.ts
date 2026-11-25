import { contextBridge, ipcRenderer } from 'electron';
import type { AgentStreamEvent, SmolCodeApi } from '../src/shared/types';

const api: SmolCodeApi = {
  getSettings: () => ipcRenderer.invoke('smolcode:get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('smolcode:update-settings', patch),
  listOllamaModels: () => ipcRenderer.invoke('smolcode:list-ollama-models'),
  getVramStatus: () => ipcRenderer.invoke('smolcode:get-vram-status'),
  openInEditor: (targetPath, editor) =>
    ipcRenderer.invoke('smolcode:open-in-editor', targetPath, editor),
  toggleMiniWindow: (mini) => ipcRenderer.invoke('smolcode:toggle-mini-window', mini),
  showDesktopNotification: (title, body) =>
    ipcRenderer.invoke('smolcode:show-desktop-notification', title, body),
  transcribeAudio: (audioBase64, mimeType) =>
    ipcRenderer.invoke('smolcode:transcribe-audio', audioBase64, mimeType),

  listProjects: () => ipcRenderer.invoke('smolcode:list-projects'),
  pickProjectFolder: () => ipcRenderer.invoke('smolcode:pick-project-folder'),
  addProject: (rootPath) => ipcRenderer.invoke('smolcode:add-project', rootPath),
  removeProject: (projectId) => ipcRenderer.invoke('smolcode:remove-project', projectId),
  setProjectCollapsed: (projectId, collapsed) =>
    ipcRenderer.invoke('smolcode:set-project-collapsed', projectId, collapsed),

  listThreads: (projectId) => ipcRenderer.invoke('smolcode:list-threads', projectId),
  createThread: (input) => ipcRenderer.invoke('smolcode:create-thread', input),
  updateThread: (threadId, patch) =>
    ipcRenderer.invoke('smolcode:update-thread', threadId, patch),
  deleteThread: (threadId) => ipcRenderer.invoke('smolcode:delete-thread', threadId),
  listTurns: (threadId) => ipcRenderer.invoke('smolcode:list-turns', threadId),

  sendPrompt: (input) => ipcRenderer.invoke('smolcode:send-prompt', input),
  steerThread: (input) => ipcRenderer.invoke('smolcode:steer-thread', input),
  enqueuePrompt: (input) => ipcRenderer.invoke('smolcode:enqueue-prompt', input),
  removeQueuedPrompt: (threadId, queueId) =>
    ipcRenderer.invoke('smolcode:remove-queued-prompt', threadId, queueId),
  stopThread: (threadId) => ipcRenderer.invoke('smolcode:stop-thread', threadId),
  resolveApproval: (requestId, decision) =>
    ipcRenderer.invoke('smolcode:resolve-approval', requestId, decision),
  answerQuestionPrompt: (threadId, turnId, promptId, answers, answersByQuestion) =>
    ipcRenderer.invoke(
      'smolcode:answer-question-prompt',
      threadId,
      turnId,
      promptId,
      answers,
      answersByQuestion,
    ),
  approvePlanAndBuild: (threadId, turnId) =>
    ipcRenderer.invoke('smolcode:approve-plan-and-build', threadId, turnId),
  compactThread: (threadId) => ipcRenderer.invoke('smolcode:compact-thread', threadId),
  previewUndoToTurn: (threadId, turnId) =>
    ipcRenderer.invoke('smolcode:preview-undo-to-turn', threadId, turnId),
  restoreTurnSnapshot: (threadId, turnId) =>
    ipcRenderer.invoke('smolcode:restore-turn-snapshot', threadId, turnId),
  revertUndoRollback: (threadId, redoId) =>
    ipcRenderer.invoke('smolcode:revert-undo-rollback', threadId, redoId),
  forkThreadFromTurn: (threadId, turnId) =>
    ipcRenderer.invoke('smolcode:fork-thread-from-turn', threadId, turnId),
  searchSymbolsAndFiles: (projectId, query) =>
    ipcRenderer.invoke('smolcode:search-symbols-files', projectId, query),
  readFileSlice: (projectId, filePath, startLine, endLine) =>
    ipcRenderer.invoke('smolcode:read-file-slice', projectId, filePath, startLine, endLine),
  pickAttachmentFiles: (projectId) =>
    ipcRenderer.invoke('smolcode:pick-attachment-files', projectId),

  listSkills: (projectId) => ipcRenderer.invoke('smolcode:list-skills', projectId),
  createSkill: (input) => ipcRenderer.invoke('smolcode:create-skill', input),
  updateSkill: (input) => ipcRenderer.invoke('smolcode:update-skill', input),
  deleteSkill: (sourcePath, projectId) =>
    ipcRenderer.invoke('smolcode:delete-skill', sourcePath, projectId),
  readSkillResource: (sourcePath, relFile) =>
    ipcRenderer.invoke('smolcode:read-skill-resource', sourcePath, relFile),
  listAutomations: (projectId) => ipcRenderer.invoke('smolcode:list-automations', projectId),
  saveAutomation: (rule) => ipcRenderer.invoke('smolcode:save-automation', rule),
  deleteAutomation: (id) => ipcRenderer.invoke('smolcode:delete-automation', id),
  runAutomationNow: (id) => ipcRenderer.invoke('smolcode:run-automation-now', id),
  getProjectEnvironment: (projectId) =>
    ipcRenderer.invoke('smolcode:get-project-environment', projectId),
  saveProjectEnvironment: (env) =>
    ipcRenderer.invoke('smolcode:save-project-environment', env),
  listMcpServers: () => ipcRenderer.invoke('smolcode:list-mcp-servers'),
  saveMcpServer: (server) => ipcRenderer.invoke('smolcode:save-mcp-server', server),
  deleteMcpServer: (id) => ipcRenderer.invoke('smolcode:delete-mcp-server', id),
  testMcpServer: (id) => ipcRenderer.invoke('smolcode:test-mcp-server', id),

  spawnTerminal: (input) => ipcRenderer.invoke('smolcode:spawn-terminal', input),
  writeTerminal: (ptyId, data) => ipcRenderer.invoke('smolcode:write-terminal', ptyId, data),
  resizeTerminal: (ptyId, cols, rows) =>
    ipcRenderer.invoke('smolcode:resize-terminal', ptyId, cols, rows),
  closeTerminal: (ptyId) => ipcRenderer.invoke('smolcode:close-terminal', ptyId),

  onAgentEvent: (cb) => {
    const handler = (_ev: unknown, payload: AgentStreamEvent) => cb(payload);
    ipcRenderer.on('smolcode:agent-event', handler);
    return () => ipcRenderer.removeListener('smolcode:agent-event', handler);
  },
  onTerminalData: (cb) => {
    const handler = (_ev: unknown, payload: { ptyId: string; data: string }) => cb(payload);
    ipcRenderer.on('smolcode:terminal-data', handler);
    return () => ipcRenderer.removeListener('smolcode:terminal-data', handler);
  },
  onTerminalExit: (cb) => {
    const handler = (_ev: unknown, payload: { ptyId: string; code: number }) => cb(payload);
    ipcRenderer.on('smolcode:terminal-exit', handler);
    return () => ipcRenderer.removeListener('smolcode:terminal-exit', handler);
  },
};

contextBridge.exposeInMainWorld('smolcode', api);
