import { dialog, ipcMain, nativeTheme, Notification, shell, type BrowserWindow, type Rectangle } from 'electron';
import { exec, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, relative } from 'node:path';
import { promisify } from 'node:util';
import { resolveWindowMaterial } from '../../src/shared/theme-presets';
import { resolveInsideWorkdir } from '../tools/fs-tools';
import type {
  AppSettings,
  ApprovalDecision,
  ApprovalPolicy,
  AutomationRule,
  ComposerChip,
  EffortLevel,
  InteractionMode,
  McpServerConfig,
  PreferredEditor,
  ProjectEnvironment,
  ThreadRecord,
} from '../../src/shared/types';
import type { AutomationRunner } from '../agent/automation-runner';
import type { AgentOrchestrator } from '../agent/orchestrator';
import type { McpManager } from '../mcp/mcp-manager';
import type { OllamaClient } from '../ollama/client';
import type { VramScheduler } from '../ollama/vram-scheduler';
import type { SmolCodeStore } from '../store/database';
import type { SnapshotManager } from '../store/snapshots';
import { UndoService } from '../store/undo-service';
import type { PtyManager } from '../terminal/pty-manager';
import {
  deleteSkillFile,
  discoverSkills,
  readSkillResource,
  saveSkillFile,
} from '../tools/agents-skills';

const execAsync = promisify(exec);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const check = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    await execAsync(check);
    return true;
  } catch {
    return false;
  }
}

export function registerIpcHandlers(deps: {
  getWindow: () => BrowserWindow | null;
  store: SmolCodeStore;
  snapshots: SnapshotManager;
  ollama: OllamaClient;
  scheduler: VramScheduler;
  orchestrator: AgentOrchestrator;
  automations: AutomationRunner;
  ptyManager: PtyManager;
  mcp: McpManager;
}): void {
  const {
    getWindow,
    store,
    snapshots,
    ollama,
    scheduler,
    orchestrator,
    automations,
    ptyManager,
    mcp,
  } = deps;

  let savedNormalBounds: Rectangle | null = null;
  let isMini = false;
  const undoService = new UndoService(store, snapshots);

  const resolveThreadWorkdir = (threadId: string): {
    thread: ThreadRecord;
    projectRoot: string;
    workdir: string;
  } => {
    const thread = store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const project = store.getProject(thread.projectId);
    if (!project) throw new Error(`Project not found: ${thread.projectId}`);
    return { thread, projectRoot: project.rootPath, workdir: project.rootPath };
  };

  orchestrator.subscribe((ev) => {
    getWindow()?.webContents.send('smolcode:agent-event', ev);
  });

  ipcMain.handle('smolcode:get-settings', () => store.getSettings());
  ipcMain.handle('smolcode:update-settings', (_e, patch: Partial<AppSettings>) => {
    const next = store.updateSettings(patch);
    if (patch.ollamaBaseUrl) {
      ollama.setBaseUrl(patch.ollamaBaseUrl);
    }
    if (
      patch.theme !== undefined ||
      patch.themePreset !== undefined ||
      patch.glassIntensity !== undefined
    ) {
      const win = getWindow();
      nativeTheme.themeSource = next.theme;
      const windowMat = resolveWindowMaterial(
        next.theme,
        next.themePreset,
        next.glassIntensity,
        nativeTheme.shouldUseDarkColors,
      );
      if (process.platform === 'win32') {
        win?.setBackgroundMaterial?.(windowMat.useAcrylic ? 'acrylic' : 'none');
      }
      win?.setBackgroundColor?.(windowMat.backgroundColor);
      win?.setTitleBarOverlay?.({
        color: windowMat.overlayColor,
        symbolColor: windowMat.symbolColor,
        height: 38,
      });
    }
    return next;
  });

  ipcMain.handle('smolcode:list-ollama-models', () => orchestrator.refreshModelCatalog());
  ipcMain.handle('smolcode:get-vram-status', () => scheduler.probeVram());

  ipcMain.handle(
    'smolcode:open-in-editor',
    async (_e, targetPath: string, editor: PreferredEditor) => {
      if (!targetPath) return { ok: false, message: 'No target path' };
      try {
        if (editor === 'explorer') {
          const err = await shell.openPath(targetPath);
          return err ? { ok: false, message: err } : { ok: true };
        }
        if (editor === 'terminal') {
          if (process.platform === 'win32') {
            spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit'], {
              cwd: targetPath,
              detached: true,
              stdio: 'ignore',
            }).unref();
          } else {
            await shell.openPath(targetPath);
          }
          return { ok: true };
        }

        const candidates: Array<{ cmd: string; name: string }> =
          editor === 'cursor'
            ? [{ cmd: 'cursor', name: 'Cursor' }]
            : editor === 'windsurf'
              ? [{ cmd: 'windsurf', name: 'Windsurf' }]
              : editor === 'vscode'
                ? [{ cmd: 'code', name: 'VS Code' }]
                : [
                    { cmd: 'cursor', name: 'Cursor' },
                    { cmd: 'code', name: 'VS Code' },
                    { cmd: 'windsurf', name: 'Windsurf' },
                  ];

        for (const c of candidates) {
          if (await commandExists(c.cmd)) {
            spawn(c.cmd, [targetPath], {
              detached: true,
              stdio: 'ignore',
              shell: process.platform === 'win32',
            }).unref();
            return { ok: true, message: `Opened in ${c.name}` };
          }
        }
        await shell.openPath(targetPath);
        return { ok: true, message: 'Opened in system file explorer' };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle('smolcode:toggle-mini-window', (_e, mini: boolean) => {
    const win = getWindow();
    if (!win) return false;
    if (mini && !isMini) {
      savedNormalBounds = win.getBounds();
      win.setAlwaysOnTop(true);
      win.setSize(440, 680);
      isMini = true;
    } else if (!mini && isMini) {
      win.setAlwaysOnTop(false);
      if (savedNormalBounds) {
        win.setBounds(savedNormalBounds);
      } else {
        win.setSize(1440, 920);
      }
      isMini = false;
    }
    return isMini;
  });

  ipcMain.handle(
    'smolcode:show-desktop-notification',
    (_e, title: string, body: string) => {
      if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
    },
  );

  ipcMain.handle(
    'smolcode:transcribe-audio',
    async (_e, audioBase64: string, mimeType: string) => {
      const settings = store.getSettings();
      if (!settings.sttEndpointUrl.trim()) {
        return {
          ok: false,
          error: 'No Whisper / STT endpoint configured in Settings → Notifications & Voice.',
        };
      }
      try {
        const buffer = Buffer.from(audioBase64, 'base64');
        const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), `audio.${ext}`);
        form.append('model', settings.sttModel || 'whisper-1');

        const resp = await fetch(settings.sttEndpointUrl.trim(), {
          method: 'POST',
          body: form,
        });
        if (!resp.ok) {
          return { ok: false, error: `STT server returned HTTP ${resp.status}` };
        }
        const json = (await resp.json()) as { text?: string };
        return { ok: true, text: (json.text ?? '').trim() };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle('smolcode:list-projects', () => store.listProjects());
  ipcMain.handle('smolcode:pick-project-folder', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory'],
      title: 'Open Project Folder',
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const rootPath = res.filePaths[0];
    return store.upsertProject({
      name: basename(rootPath),
      rootPath,
    });
  });

  ipcMain.handle('smolcode:add-project', (_e, rootPath: string) =>
    store.upsertProject({
      name: basename(rootPath),
      rootPath,
    }),
  );

  ipcMain.handle('smolcode:remove-project', (_e, projectId: string) => {
    store.removeProject(projectId);
  });

  ipcMain.handle(
    'smolcode:set-project-collapsed',
    (_e, projectId: string, collapsed: boolean) => {
      store.setProjectCollapsed(projectId, collapsed);
    },
  );

  ipcMain.handle('smolcode:list-threads', (_e, projectId?: string) =>
    store.listThreads(projectId),
  );

  ipcMain.handle(
    'smolcode:create-thread',
    (
      _e,
      input: {
        projectId: string;
        interactionMode?: InteractionMode;
        mainModel?: string;
        fastModel?: string;
        effort?: EffortLevel;
        approvalPolicy?: ApprovalPolicy;
      },
    ) => {
      const project = store.getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);
      const settings = store.getSettings();
      const threadId = crypto.randomUUID();

      return store.createThread({
        id: threadId,
        projectId: project.id,
        title: 'New thread',
        interactionMode: input.interactionMode ?? 'build',
        mainModel: input.mainModel ?? settings.defaultMainModel,
        fastModel: input.fastModel ?? settings.defaultFastModel,
        effort: input.effort ?? settings.defaultEffort,
        approvalPolicy: input.approvalPolicy ?? settings.defaultApprovalPolicy,
        draftText: '',
        draftChips: [],
        queuedPrompts: [],
        status: 'idle',
        unread: false,
        pinned: false,
        archived: false,
      });
    },
  );

  ipcMain.handle(
    'smolcode:update-thread',
    (_e, threadId: string, patch: Partial<ThreadRecord>) => {
      return store.updateThread(threadId, patch);
    },
  );

  ipcMain.handle('smolcode:delete-thread', (_e, threadId: string) => {
    orchestrator.stopThread(threadId);
    store.deleteThread(threadId);
  });

  ipcMain.handle('smolcode:list-turns', (_e, threadId: string) =>
    store.listTurns(threadId),
  );

  ipcMain.handle(
    'smolcode:send-prompt',
    (_e, input: { threadId: string; content: string; chips?: ComposerChip[] }) => {
      void orchestrator.runUserTurn(input);
    },
  );

  ipcMain.handle(
    'smolcode:steer-thread',
    (_e, input: { threadId: string; content: string; chips?: ComposerChip[] }) => {
      orchestrator.steerThread(input.threadId, input.content, input.chips);
    },
  );

  ipcMain.handle(
    'smolcode:enqueue-prompt',
    (_e, input: { threadId: string; content: string; chips?: ComposerChip[] }) =>
      orchestrator.enqueuePrompt(input.threadId, input.content, input.chips),
  );

  ipcMain.handle(
    'smolcode:remove-queued-prompt',
    (_e, threadId: string, queueId: string) =>
      orchestrator.removeQueuedPrompt(threadId, queueId),
  );

  ipcMain.handle('smolcode:stop-thread', (_e, threadId: string) => {
    orchestrator.stopThread(threadId);
  });

  ipcMain.handle(
    'smolcode:resolve-approval',
    (_e, requestId: string, decision: ApprovalDecision) => {
      orchestrator.resolveApproval(requestId, decision);
    },
  );

  ipcMain.handle(
    'smolcode:answer-question-prompt',
    (
      _e,
      threadId: string,
      turnId: string,
      promptId: string,
      answers: string[],
      answersByQuestion?: Record<string, string[]>,
    ) => {
      orchestrator.answerQuestionPrompt(
        threadId,
        turnId,
        promptId,
        answers,
        answersByQuestion,
      );
    },
  );

  ipcMain.handle(
    'smolcode:approve-plan-and-build',
    (_e, threadId: string, turnId: string) => {
      void orchestrator.approvePlanAndBuild(threadId, turnId);
    },
  );

  ipcMain.handle('smolcode:compact-thread', (_e, threadId: string) =>
    orchestrator.compactThread(threadId),
  );

  ipcMain.handle(
    'smolcode:preview-undo-to-turn',
    (_e, threadId: string, turnId: string) => {
      return undoService.previewUndoToTurn(threadId, turnId);
    },
  );

  ipcMain.handle(
    'smolcode:restore-turn-snapshot',
    (_e, threadId: string, turnId: string) => {
      const { result, updatedDraftThread } = undoService.executeUndoToTurn(
        threadId,
        turnId,
        (workdir, changedPaths) => {
          orchestrator.invalidateAfterRestore(threadId, workdir, changedPaths);
        },
      );
      getWindow()?.webContents.send('smolcode:agent-event', {
        type: 'thread_updated',
        thread: updatedDraftThread,
      });
      return result;
    },
  );

  ipcMain.handle(
    'smolcode:revert-undo-rollback',
    (_e, threadId: string, redoId: string) => {
      const { restoredFiles, removedFiles, turnsRestored, updatedDraftThread } =
        undoService.revertUndoRollback(threadId, redoId, (workdir, changedPaths) => {
          orchestrator.invalidateAfterRestore(threadId, workdir, changedPaths);
        });
      getWindow()?.webContents.send('smolcode:agent-event', {
        type: 'thread_updated',
        thread: updatedDraftThread,
      });
      return { restoredFiles, removedFiles, turnsRestored };
    },
  );

  ipcMain.handle(
    'smolcode:fork-thread-from-turn',
    async (_e, threadId: string, turnId: string) => {
      const src = store.getThread(threadId);
      if (!src) throw new Error(`Thread not found: ${threadId}`);
      const forked = store.createThread({
        projectId: src.projectId,
        title: `${src.title} (Fork)`,
        interactionMode: src.interactionMode,
        mainModel: src.mainModel,
        fastModel: src.fastModel,
        effort: src.effort,
        approvalPolicy: src.approvalPolicy,
        draftText: '',
        draftChips: [],
        queuedPrompts: [],
        status: 'idle',
        unread: false,
        pinned: false,
        archived: false,
      });

      const turns = store.listTurns(threadId);
      for (const t of turns) {
        store.insertTurn({ ...t, id: crypto.randomUUID(), threadId: forked.id });
        if (t.id === turnId) break;
      }
      return forked;
    },
  );

  ipcMain.handle(
    'smolcode:search-symbols-files',
    (_e, projectId: string, query: string) =>
      orchestrator.searchSymbolsAndFiles(projectId, query),
  );

  ipcMain.handle(
    'smolcode:read-file-slice',
    (_e, projectId: string, filePath: string, startLine = 1, endLine?: number) => {
      const project = store.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const { absPath, relPath, inside } = resolveInsideWorkdir(project.rootPath, filePath);
      if (!inside || !existsSync(absPath)) {
        throw new Error(`File not found inside workspace: ${filePath}`);
      }
      const raw = readFileSync(absPath, 'utf8');
      const allLines = raw.split(/\r?\n/);
      const from = Math.max(1, Math.floor(startLine || 1));
      const to = Math.min(
        allLines.length,
        Math.max(from, endLine !== undefined ? Math.min(endLine, from + 199) : from + 119),
      );
      const lines = [];
      for (let ln = from; ln <= to; ln++) {
        lines.push({ line: ln, text: allLines[ln - 1] ?? '' });
      }
      return {
        absPath,
        relPath,
        startLine: from,
        endLine: to,
        totalLines: allLines.length,
        lines,
      };
    },
  );

  ipcMain.handle(
    'smolcode:pick-attachment-files',
    async (_e, projectId: string) => {
      const win = getWindow();
      const project = store.getProject(projectId);
      const rootDir = project?.rootPath;
      const res = await dialog.showOpenDialog(win ?? undefined!, {
        defaultPath: rootDir,
        properties: ['openFile', 'multiSelections'],
        title: 'Attach Files or Images',
      });
      if (res.canceled || res.filePaths.length === 0) return [];
      const chips: ComposerChip[] = [];
      for (const absPath of res.filePaths.slice(0, 8)) {
        const ext = extname(absPath).toLowerCase();
        const isImg = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
        if (isImg) {
          const dataBase64 = readFileSync(absPath).toString('base64');
          const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
          chips.push({
            id: `img:${Date.now()}:${basename(absPath)}`,
            kind: 'image',
            label: basename(absPath),
            mimeType: mime,
            dataBase64,
          });
        } else {
          const rel = rootDir ? relative(rootDir, absPath).replace(/\\/g, '/') : absPath;
          chips.push({
            id: `file:${rel}`,
            kind: 'file',
            label: rel,
            filePath: rel,
          });
        }
      }
      return chips;
    },
  );

  ipcMain.handle('smolcode:list-skills', (_e, projectId?: string) => {
    const project = projectId ? store.getProject(projectId) : null;
    return discoverSkills(project?.rootPath);
  });

  const handleSaveSkill = (input: {
    projectId?: string;
    scope: 'repo' | 'global';
    name: string;
    description: string;
    content: string;
    tags?: string[];
    companionFiles?: Array<{ path: string; content: string }>;
  }) => {
    const project = input.projectId ? store.getProject(input.projectId) : null;
    const saved = saveSkillFile({
      projectRoot: project?.rootPath,
      scope: input.scope,
      name: input.name,
      description: input.description,
      content: input.content,
      tags: input.tags,
      companionFiles: input.companionFiles,
    });
    const skills = discoverSkills(project?.rootPath);
    getWindow()?.webContents.send('smolcode:agent-event', {
      type: 'skills_updated',
      projectId: input.projectId,
      skills,
    });
    return saved;
  };

  ipcMain.handle('smolcode:create-skill', (_e, input) => handleSaveSkill(input));
  ipcMain.handle('smolcode:update-skill', (_e, input) => handleSaveSkill(input));

  ipcMain.handle(
    'smolcode:delete-skill',
    (_e, sourcePath: string, projectId?: string) => {
      const project = projectId ? store.getProject(projectId) : null;
      deleteSkillFile(sourcePath, project?.rootPath);
      const skills = discoverSkills(project?.rootPath);
      getWindow()?.webContents.send('smolcode:agent-event', {
        type: 'skills_updated',
        projectId,
        skills,
      });
    },
  );

  ipcMain.handle(
    'smolcode:read-skill-resource',
    (_e, sourcePath: string, relFile: string) =>
      readSkillResource(sourcePath, relFile),
  );

  ipcMain.handle('smolcode:list-automations', (_e, projectId?: string) =>
    store.listAutomations(projectId),
  );

  ipcMain.handle(
    'smolcode:save-automation',
    (_e, rule: Partial<AutomationRule> & { projectId: string }) =>
      store.saveAutomation(rule),
  );

  ipcMain.handle('smolcode:delete-automation', (_e, id: string) => {
    store.deleteAutomation(id);
  });

  ipcMain.handle('smolcode:run-automation-now', (_e, id: string) => {
    const rule = store.listAutomations().find((r) => r.id === id);
    if (rule) {
      void automations.runNow(rule);
    }
  });

  ipcMain.handle('smolcode:get-project-environment', (_e, projectId: string) =>
    store.getProjectEnvironment(projectId),
  );

  ipcMain.handle(
    'smolcode:save-project-environment',
    (_e, env: ProjectEnvironment) => store.saveProjectEnvironment(env),
  );

  ipcMain.handle('smolcode:list-mcp-servers', () => store.listMcpServers());

  ipcMain.handle(
    'smolcode:save-mcp-server',
    (_e, server: Partial<McpServerConfig> & { name: string }) => {
      const saved = store.saveMcpServer(server);
      void mcp.invalidateServer(saved.id);
      return saved;
    },
  );

  ipcMain.handle('smolcode:delete-mcp-server', (_e, id: string) => {
    void mcp.invalidateServer(id);
    store.deleteMcpServer(id);
  });

  ipcMain.handle('smolcode:test-mcp-server', async (_e, id: string) => {
    const server = store.listMcpServers().find((s) => s.id === id);
    if (!server) throw new Error(`MCP server not found: ${id}`);
    try {
      const tools = await mcp.listTools(server);
      return store.saveMcpServer({
        ...server,
        lastStatus: 'ok',
        lastError: undefined,
        tools,
      });
    } catch (err) {
      return store.saveMcpServer({
        ...server,
        lastStatus: 'error',
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ipcMain.handle(
    'smolcode:spawn-terminal',
    (
      _e,
      input: {
        threadId: string;
        cols: number;
        rows: number;
        shellPref?: AppSettings['defaultShell'];
      },
    ) => {
      const { workdir } = resolveThreadWorkdir(input.threadId);
      const settings = store.getSettings();
      return ptyManager.spawn({
        cwd: workdir,
        cols: input.cols,
        rows: input.rows,
        shellPref: input.shellPref ?? settings.defaultShell,
      });
    },
  );

  ipcMain.handle('smolcode:write-terminal', (_e, ptyId: string, data: string) => {
    ptyManager.write(ptyId, data);
  });

  ipcMain.handle(
    'smolcode:resize-terminal',
    (_e, ptyId: string, cols: number, rows: number) => {
      ptyManager.resize(ptyId, cols, rows);
    },
  );

  ipcMain.handle('smolcode:close-terminal', (_e, ptyId: string) => {
    ptyManager.close(ptyId);
  });
}
