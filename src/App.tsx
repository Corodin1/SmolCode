import { useCallback, useEffect, useRef, useState } from 'react';
import { FrostedSurface } from './components/Common/FrostedSurface';
import { Composer } from './components/Composer/Composer';
import { CommandPalette, type PaletteCommand } from './components/Modals/CommandPalette';
import { FilePreviewModal, type FilePreviewTarget } from './components/Modals/FilePreviewModal';
import { ShortcutsModal } from './components/Modals/ShortcutsModal';
import { UndoConfirmModal } from './components/Modals/UndoConfirmModal';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TerminalDrawer } from './components/Terminal/TerminalDrawer';
import { ThreadView } from './components/Thread/ThreadView';
import { Titlebar } from './components/Titlebar';
import { ArchivedThreadsView } from './components/Views/ArchivedThreadsView';
import { AutomationsView } from './components/Views/AutomationsView';
import { SettingsView } from './components/Views/SettingsView';
import { SkillsView } from './components/Views/SkillsView';
import type { ApprovalRequest, ThreadRecord } from './shared/types';
import { useAgentStream } from './state/useAgentStream';
import { useWorkspaceStore } from './state/useWorkspaceStore';
import { playCompletionChime } from './utils/audio-notify';

export function App() {
  const ws = useWorkspaceStore();
  const {
    setThreads,
    activeThreadId,
    refreshVram,
    settings,
  } = ws;
  const [draggingPane, setDraggingPane] = useState<'sidebar' | 'terminal' | null>(
    null,
  );
  const [composerRevision, setComposerRevision] = useState(0);
  const [filePreviewTarget, setFilePreviewTarget] = useState<FilePreviewTarget | null>(null);
  const [undoTargetTurnId, setUndoTargetTurnId] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);

  const handleThreadPatchLocal = useCallback(
    (threadId: string, patch: Partial<ThreadRecord>) => {
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, ...patch } : t)),
      );
    },
    [setThreads],
  );

  const handleThreadReplaced = useCallback(
    (thread: ThreadRecord) => {
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? thread : t)));
    },
    [setThreads],
  );

  const handleTurnFinished = useCallback(
    (threadId: string, threadTitle?: string) => {
      if (threadId === activeThreadId) {
        void refreshVram();
      }
      if (settings.soundOnComplete) {
        playCompletionChime();
      }
      if (settings.notifyOnComplete && threadId !== activeThreadId) {
        void window.smolcode?.showDesktopNotification(
          'SmolCode finished a task',
          threadTitle || 'Background thread completed',
        );
      }
    },
    [activeThreadId, refreshVram, settings.notifyOnComplete, settings.soundOnComplete],
  );

  const handleApprovalRequested = useCallback(
    (req: ApprovalRequest) => {
      if (settings.notifyOnComplete && req.threadId !== activeThreadId) {
        void window.smolcode?.showDesktopNotification(
          'SmolCode needs approval',
          req.commandOrPath,
        );
      }
    },
    [activeThreadId, settings.notifyOnComplete],
  );

  const stream = useAgentStream({
    activeThreadId: ws.activeThreadId,
    onThreadStatusChange: handleThreadPatchLocal,
    onThreadReplaced: handleThreadReplaced,
    onTurnFinished: handleTurnFinished,
    onApprovalRequested: handleApprovalRequested,
  });

  const latestTelemetry =
    [...stream.turns].reverse().find((t) => t.telemetry)?.telemetry ?? null;

  // Global Codex keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        ws.setPaletteOpen((v) => !v);
      } else if (key === 'b') {
        e.preventDefault();
        ws.setSidebarOpen((v) => !v);
      } else if (key === 'j') {
        e.preventDefault();
        ws.setTerminalOpen((v) => !v);
      } else if (e.shiftKey && key === 'm') {
        e.preventDefault();
        void ws.toggleMiniMode();
      } else if (key === 'n') {
        e.preventDefault();
        if (ws.activeProject) {
          void ws.createThread(ws.activeProject.id);
        }
      } else if (key === ',') {
        e.preventDefault();
        ws.setSettingsTab('general');
        ws.setCenterView('settings');
      } else if (key === '/') {
        e.preventDefault();
        ws.setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ws]);

  // Pointer-capture drag resizing
  useEffect(() => {
    if (!draggingPane) return;
    const onMove = (e: PointerEvent) => {
      if (draggingPane === 'sidebar') {
        ws.setSidebarWidth(Math.max(210, Math.min(360, e.clientX)));
      } else if (draggingPane === 'terminal') {
        ws.setTerminalHeight(Math.max(130, Math.min(460, window.innerHeight - e.clientY)));
      }
    };
    const onUp = () => setDraggingPane(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [draggingPane, ws]);

  // Keep --composer-dock-height synced with floating Composer size for scroll-under clearance
  useEffect(() => {
    const stageEl = stageRef.current;
    const dockEl = composerDockRef.current;
    if (!stageEl) return;
    if (!dockEl) {
      stageEl.style.setProperty('--composer-dock-height', '0px');
      return;
    }
    const syncDockHeight = () => {
      const h = Math.ceil(dockEl.getBoundingClientRect().height);
      if (h > 0) {
        stageEl.style.setProperty('--composer-dock-height', `${h}px`);
      }
    };
    syncDockHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncDockHeight);
    ro.observe(dockEl);
    return () => ro.disconnect();
  }, [ws.activeThread?.id, ws.centerView]);

  const handleSlashAction = async (cmdName: string) => {
    const th = ws.activeThread;
    if (cmdName === 'new') {
      if (ws.activeProject) await ws.createThread(ws.activeProject.id);
      return;
    }
    if (cmdName === 'skills') {
      ws.setCenterView('skills');
      return;
    }
    if (cmdName === 'mcp') {
      ws.setSettingsTab('mcp');
      ws.setCenterView('settings');
      return;
    }
    if (!th) return;

    if (cmdName === 'plan') {
      await ws.updateThread(th.id, {
        interactionMode: th.interactionMode === 'plan' ? 'build' : 'plan',
      });
      return;
    }
    if (cmdName === 'compact') {
      await window.smolcode.compactThread(th.id);
      const reloaded = await window.smolcode.listTurns(th.id);
      stream.setTurns(reloaded);
      ws.showToast('Thread context compacted');
      return;
    }
    if (cmdName === 'init') {
      await window.smolcode.sendPrompt({
        threadId: th.id,
        content:
          'Analyze this repository structure, test/build scripts, and conventions, then create or update AGENTS.md at the project root.',
      });
    }
  };

  const paletteCommands: PaletteCommand[] = [
    {
      id: 'cmd-new-thread',
      label: 'New Thread',
      group: 'Workspace',
      shortcut: 'Ctrl+N',
      run: () => {
        if (ws.activeProject) void ws.createThread(ws.activeProject.id);
      },
    },
    {
      id: 'cmd-open-folder',
      label: 'Open Project Folder',
      group: 'Workspace',
      run: () => void ws.pickAndOpenProject(),
    },
    {
      id: 'cmd-skills',
      label: 'Browse Skills',
      group: 'Navigation',
      run: () => ws.setCenterView('skills'),
    },
    {
      id: 'cmd-automations',
      label: 'Open Automations',
      group: 'Navigation',
      run: () => ws.setCenterView('automations'),
    },
    {
      id: 'cmd-archived',
      label: 'Archived Threads',
      group: 'Navigation',
      run: () => ws.setCenterView('archived'),
    },
    {
      id: 'cmd-toggle-sidebar',
      label: 'Toggle Sidebar',
      group: 'View',
      shortcut: 'Ctrl+B',
      run: () => ws.setSidebarOpen((v) => !v),
    },
    {
      id: 'cmd-toggle-terminal',
      label: 'Toggle Integrated Terminal',
      group: 'View',
      shortcut: 'Ctrl+J',
      run: () => ws.setTerminalOpen((v) => !v),
    },
    {
      id: 'cmd-mini-window',
      label: 'Toggle Pop-out Mini Window',
      group: 'View',
      shortcut: 'Ctrl+Shift+M',
      run: () => void ws.toggleMiniMode(),
    },
    {
      id: 'cmd-toggle-theme',
      label: `Switch to ${ws.resolvedTheme === 'dark' ? 'Light' : 'Dark'} Theme`,
      group: 'Appearance',
      run: () =>
        void ws.updateSettings({
          theme: ws.resolvedTheme === 'dark' ? 'light' : 'dark',
        }),
    },
    {
      id: 'cmd-settings',
      label: 'Open Settings',
      group: 'Preferences',
      shortcut: 'Ctrl+,',
      run: () => {
        ws.setSettingsTab('general');
        ws.setCenterView('settings');
      },
    },
    {
      id: 'cmd-shortcuts',
      label: 'Keyboard Shortcuts',
      group: 'Help',
      shortcut: 'Ctrl+/',
      run: () => ws.setShortcutsOpen(true),
    },
  ];

  const activeWorkdir = ws.activeProject?.rootPath ?? '';

  return (
    <div className="app-shell">
      <Titlebar
        project={ws.activeProject}
        thread={ws.activeThread}
        centerView={ws.centerView}
        theme={ws.resolvedTheme}
        sidebarOpen={ws.sidebarOpen}
        terminalOpen={ws.terminalOpen}
        miniWindow={ws.miniWindow}
        preferredEditor={ws.settings.preferredEditor}
        onToggleSidebar={() => ws.setSidebarOpen((v) => !v)}
        onToggleTerminal={() => ws.setTerminalOpen((v) => !v)}
        onToggleTheme={() =>
          void ws.updateSettings({
            theme: ws.resolvedTheme === 'dark' ? 'light' : 'dark',
          })
        }
        onToggleMiniWindow={() => void ws.toggleMiniMode()}
        onNewThread={() => {
          if (ws.activeProject) void ws.createThread(ws.activeProject.id);
          else void ws.pickAndOpenProject();
        }}
        onRenameThread={(title) => {
          if (ws.activeThread) void ws.updateThread(ws.activeThread.id, { title });
        }}
        onOpenInEditor={(editor) => {
          if (!activeWorkdir) return;
          void window.smolcode?.openInEditor(activeWorkdir, editor).then((res) => {
            if (res.message) ws.showToast(res.message);
          });
        }}
      />

      <div className="workspace-body">
        {ws.sidebarOpen && (
          <>
            <Sidebar
              width={ws.sidebarWidth}
              centerView={ws.centerView}
              projects={ws.projects}
              threads={ws.threads}
              activeThreadId={ws.activeThreadId}
              skillsCount={ws.skills.length}
              automationsCount={ws.automations.length}
              onNewThread={(pid) => {
                const target = pid ?? ws.activeProject?.id;
                if (target) void ws.createThread(target);
                else void ws.pickAndOpenProject();
              }}
              onAddProject={() => void ws.pickAndOpenProject()}
              onRemoveProject={(pid) => void ws.removeProject(pid)}
              onOpenProjectEnv={(_pid) => {
                ws.setSettingsTab('environments');
                ws.setCenterView('settings');
              }}
              onToggleProject={(pid, collapsed) => {
                ws.setProjects((prev) =>
                  prev.map((p) => (p.id === pid ? { ...p, collapsed } : p)),
                );
                void window.smolcode?.setProjectCollapsed(pid, collapsed);
              }}
              onSelectThread={(tid) => void ws.selectThread(tid)}
              onRenameThread={(tid, title) => void ws.updateThread(tid, { title })}
              onTogglePin={(th) => void ws.updateThread(th.id, { pinned: !th.pinned })}
              onArchiveThread={(tid, archived) => void ws.updateThread(tid, { archived })}
              onDeleteThread={(tid) => void ws.deleteThread(tid)}
              onNavigateView={(view) => ws.setCenterView(view)}
              onOpenShortcuts={() => ws.setShortcutsOpen(true)}
            />
            <div
              className="resize-handle-v"
              data-dragging={draggingPane === 'sidebar'}
              onPointerDown={() => setDraggingPane('sidebar')}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
            />
          </>
        )}

        <main className="center-column">
          {ws.centerView === 'skills' ? (
            <SkillsView
              project={ws.activeProject}
              skills={ws.skills}
              onBack={() => ws.setCenterView('thread')}
              onUseSkill={(sk) => {
                if (ws.activeThread) {
                  const chip = {
                    id: `skill:${sk.name}`,
                    kind: 'skill' as const,
                    label: `/${sk.name}`,
                    skillName: sk.name,
                  };
                  const existing = ws.activeThread.draftChips ?? [];
                  if (!existing.some((c) => c.id === chip.id)) {
                    void ws.updateThread(ws.activeThread.id, {
                      draftChips: [...existing, chip],
                    });
                  }
                }
                ws.setCenterView('thread');
              }}
              onCreateSkill={async (input) => {
                const created = await window.smolcode.createSkill(input);
                const refreshed = await window.smolcode.listSkills(ws.activeProject?.id);
                ws.setSkills(refreshed);
                ws.showToast(`Created skill /${created.name}`);
              }}
              onUpdateSkill={async (input) => {
                const updated = await window.smolcode.updateSkill(input);
                const refreshed = await window.smolcode.listSkills(ws.activeProject?.id);
                ws.setSkills(refreshed);
                ws.showToast(`Updated skill /${updated.name}`);
              }}
              onDeleteSkill={async (sourcePath, projectId) => {
                await window.smolcode.deleteSkill(sourcePath, projectId);
                const refreshed = await window.smolcode.listSkills(projectId);
                ws.setSkills(refreshed);
                ws.showToast('Deleted skill');
              }}
              onGenerateWithAi={() => {
                if (ws.activeThread) {
                  const chip = {
                    id: 'skill:skill-creator',
                    kind: 'skill' as const,
                    label: '/skill-creator',
                    skillName: 'skill-creator',
                  };
                  const existing = ws.activeThread.draftChips ?? [];
                  void ws.updateThread(ws.activeThread.id, {
                    draftChips: existing.some((c) => c.id === chip.id)
                      ? existing
                      : [...existing, chip],
                    draftText:
                      'Inspect this workspace and create a reusable skill in .smolcode/skills/ for: ',
                  });
                  setComposerRevision((r) => r + 1);
                }
                ws.setCenterView('thread');
              }}
            />
          ) : ws.centerView === 'automations' ? (
            <AutomationsView
              project={ws.activeProject}
              projects={ws.projects}
              automations={ws.automations}
              onBack={() => ws.setCenterView('thread')}
              onSaveAutomation={async (rule) => {
                const saved = await window.smolcode.saveAutomation(rule);
                ws.setAutomations((prev) =>
                  prev.some((a) => a.id === saved.id)
                    ? prev.map((a) => (a.id === saved.id ? saved : a))
                    : [...prev, saved],
                );
              }}
              onDeleteAutomation={async (id) => {
                await window.smolcode.deleteAutomation(id);
                ws.setAutomations((prev) => prev.filter((a) => a.id !== id));
              }}
              onRunAutomationNow={async (id) => {
                await window.smolcode.runAutomationNow(id);
                await ws.refreshAll();
              }}
              onOpenThread={(tid) => void ws.selectThread(tid)}
            />
          ) : ws.centerView === 'settings' ? (
            <SettingsView
              tab={ws.settingsTab}
              onChangeTab={ws.setSettingsTab}
              settings={ws.settings}
              models={ws.models}
              vram={ws.vram}
              projects={ws.projects}
              activeProject={ws.activeProject}
              mcpServers={ws.mcpServers}
              onBack={() => ws.setCenterView('thread')}
              onSaveSettings={async (patch) => {
                await ws.updateSettings(patch);
              }}
              onRefreshModels={async () => {
                const m = await window.smolcode.listOllamaModels();
                ws.setModels(m);
              }}
              onSaveMcpServer={async (srv) => {
                const saved = await window.smolcode.saveMcpServer(srv);
                ws.setMcpServers((prev) =>
                  prev.some((s) => s.id === saved.id)
                    ? prev.map((s) => (s.id === saved.id ? saved : s))
                    : [...prev, saved],
                );
              }}
              onDeleteMcpServer={async (id) => {
                await window.smolcode.deleteMcpServer(id);
                ws.setMcpServers((prev) => prev.filter((s) => s.id !== id));
              }}
              onTestMcpServer={async (id) => {
                const tested = await window.smolcode.testMcpServer(id);
                ws.setMcpServers((prev) =>
                  prev.map((s) => (s.id === tested.id ? tested : s)),
                );
              }}
            />
          ) : ws.centerView === 'archived' ? (
            <ArchivedThreadsView
              threads={ws.threads}
              projects={ws.projects}
              onBack={() => ws.setCenterView('thread')}
              onUnarchive={(tid) => {
                void ws.updateThread(tid, { archived: false });
                void ws.selectThread(tid);
              }}
              onDelete={(tid) => void ws.deleteThread(tid)}
            />
          ) : (
            <div ref={stageRef} className="thread-composer-stage">
              <ThreadView
                project={ws.activeProject}
                thread={ws.activeThread}
                turns={stream.turns}
                approvals={stream.pendingApprovals}
                onQuickPrompt={(prompt) => {
                  if (ws.activeThread) {
                    void window.smolcode.sendPrompt({
                      threadId: ws.activeThread.id,
                      content: prompt,
                    });
                  }
                }}
                onOpenProject={() => void ws.pickAndOpenProject()}
                onResolveApproval={(reqId, decision) => {
                  stream.clearApproval(reqId);
                  void window.smolcode.resolveApproval(reqId, decision);
                }}
                onRestoreSnapshot={(turnId) => {
                  if (!ws.activeThread) return;
                  setUndoTargetTurnId(turnId);
                }}
                onForkTurn={async (turnId) => {
                  if (!ws.activeThread) return;
                  const forked = await window.smolcode.forkThreadFromTurn(
                    ws.activeThread.id,
                    turnId,
                  );
                  ws.setThreads((prev) => [forked, ...prev]);
                  void ws.selectThread(forked.id);
                }}
                onApprovePlan={async (turnId) => {
                  if (!ws.activeThread) return;
                  stream.markPlanApprovedLocal(turnId);
                  await window.smolcode.approvePlanAndBuild(ws.activeThread.id, turnId);
                }}
                onAnswerQuestion={async (turnId, promptId, answers, answersByQuestion) => {
                  if (!ws.activeThread) return;
                  stream.markQuestionAnsweredLocal(turnId, answers, answersByQuestion);
                  await window.smolcode.answerQuestionPrompt(
                    ws.activeThread.id,
                    turnId,
                    promptId,
                    answers,
                    answersByQuestion,
                  );
                }}
                onEditUserPrompt={(content) => {
                  if (ws.activeThread) {
                    void ws.updateThread(ws.activeThread.id, { draftText: content });
                    setComposerRevision((r) => r + 1);
                  }
                }}
                onPreviewFile={(filePath, startLine, endLine) => {
                  if (!ws.activeProject) return;
                  setFilePreviewTarget({
                    projectId: ws.activeProject.id,
                    filePath,
                    startLine,
                    endLine,
                  });
                }}
                onOpenFileInEditor={(filePath) => {
                  if (!ws.activeProject) return;
                  const cleanRel = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
                  const full = `${ws.activeProject.rootPath.replace(/[\\/]+$/, '')}/${cleanRel}`;
                  void window.smolcode?.openInEditor(full, ws.settings.preferredEditor).then((res) => {
                    if (res.message) ws.showToast(res.message);
                  });
                }}
                onRetryToolError={(tool) => {
                  if (!ws.activeThread) return;
                  const detail = tool.liveOutput || tool.resultPreview || tool.argsPreview;
                  const fixPrompt = `Tool "${tool.toolName}" (${tool.summary}) failed:\n${detail.slice(0, 400)}\n\nDiagnose the cause, apply a fix, and verify.`;
                  void window.smolcode?.sendPrompt({
                    threadId: ws.activeThread.id,
                    content: fixPrompt,
                  });
                }}
                onSaveGeneratedImage={async (image) => {
                  if (!ws.activeProject) return;
                  const res = await window.smolcode.saveGeneratedImageToWorkspace({
                    projectId: ws.activeProject.id,
                    sourcePath: image.filePath,
                  });
                  ws.showToast(`Saved image to ${res.savedRelPath}`);
                }}
                onCopyGeneratedImage={async (image) => {
                  const ok = await window.smolcode.copyGeneratedImageToClipboard(image.filePath);
                  if (ok) ws.showToast('Image copied to clipboard');
                  return ok;
                }}
                onReuseImagePrompt={(prompt) => {
                  if (!ws.activeThread) return;
                  const existing = ws.activeThread.draftChips ?? [];
                  const hasImgSkill = existing.some(
                    (c) => c.kind === 'skill' && (c.skillName ?? c.label).replace(/^\/+/, '') === 'image-gen',
                  );
                  void ws.updateThread(ws.activeThread.id, {
                    draftText: prompt,
                    ...(hasImgSkill
                      ? {}
                      : {
                          draftChips: [
                            ...existing,
                            {
                              id: 'skill:image-gen',
                              kind: 'skill',
                              label: '/image-gen',
                              skillName: 'image-gen',
                            },
                          ],
                        }),
                  });
                  setComposerRevision((r) => r + 1);
                }}
              />

              {ws.activeThread && (
                <Composer
                  key={`${ws.activeThread.id}:${composerRevision}`}
                  dockRef={composerDockRef}
                  thread={ws.activeThread}
                  models={ws.models}
                  skills={ws.skills}
                  vram={ws.vram}
                  latestTelemetry={latestTelemetry}
                  showAdvancedDualModel={ws.settings.showAdvancedDualModel}
                  pinFastToCpu={ws.settings.pinFastToCpu}
                  activeContextTokens={latestTelemetry?.activeContextTokens ?? 0}
                  contextBudget={latestTelemetry?.contextBudget ?? 16384}
                  imageGenSize={ws.settings.imageGenDefaultSize}
                  onChangeImageGenSize={(size) =>
                    void ws.updateSettings({ imageGenDefaultSize: size })
                  }
                  onUpdateThread={(patch) => void ws.updateThread(ws.activeThread!.id, patch)}
                  onSendPrompt={(content, chips) =>
                    void window.smolcode.sendPrompt({
                      threadId: ws.activeThread!.id,
                      content,
                      chips,
                    })
                  }
                  onSteerThread={(content, chips) =>
                    void window.smolcode.steerThread({
                      threadId: ws.activeThread!.id,
                      content,
                      chips,
                    })
                  }
                  onEnqueuePrompt={(content, chips) => {
                    void window.smolcode
                      .enqueuePrompt({
                        threadId: ws.activeThread!.id,
                        content,
                        chips,
                      })
                      .then(handleThreadReplaced);
                  }}
                  onRemoveQueuedPrompt={(queueId) => {
                    void window.smolcode
                      .removeQueuedPrompt(ws.activeThread!.id, queueId)
                      .then(handleThreadReplaced);
                  }}
                  onStopThread={() => void window.smolcode.stopThread(ws.activeThread!.id)}
                  onSlashAction={(cmd) => void handleSlashAction(cmd)}
                  onAttachFiles={() => {
                    if (!ws.activeThread) return;
                    void window.smolcode
                      .pickAttachmentFiles(ws.activeThread.projectId)
                      .then((picked) => {
                        if (picked.length > 0 && ws.activeThread) {
                          void ws.updateThread(ws.activeThread.id, {
                            draftChips: [...(ws.activeThread.draftChips ?? []), ...picked],
                          });
                        }
                      });
                  }}
                  onOpenSkills={() => ws.setCenterView('skills')}
                />
              )}
            </div>
          )}

          {ws.terminalOpen && (
            <>
              <div
                className="resize-handle-h"
                data-dragging={draggingPane === 'terminal'}
                onPointerDown={() => setDraggingPane('terminal')}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize terminal"
              />
              <TerminalDrawer
                threadId={ws.activeThreadId}
                height={ws.terminalHeight}
                theme={ws.resolvedTheme}
                defaultShell={ws.settings.defaultShell}
                onSendSelectionToComposer={(snippet) => {
                  if (!ws.activeThread) return;
                  void ws.updateThread(ws.activeThread.id, {
                    draftChips: [
                      ...(ws.activeThread.draftChips ?? []),
                      {
                        id: `term:${Date.now()}`,
                        kind: 'terminal',
                        label: `Terminal output`,
                        body: snippet,
                      },
                    ],
                  });
                  ws.setCenterView('thread');
                }}
                onClose={() => ws.setTerminalOpen(false)}
              />
            </>
          )}
        </main>
      </div>

      {ws.toast && (
        <FrostedSurface
          variant="pill"
          cornerRadius={12}
          role="status"
          aria-live="polite"
          className="codex-popover ag-toast"
          style={{
            position: 'fixed',
            bottom: 18,
            right: 20,
            padding: '8px 14px',
            fontSize: 12.5,
            zIndex: 'var(--z-tooltip)',
          }}
        >
          <span>{ws.toast.message}</span>
          {ws.toast.actionLabel && ws.toast.onAction && (
            <button
              type="button"
              className="ag-toast-action pressable"
              onClick={() => {
                const fn = ws.toast?.onAction;
                ws.dismissToast();
                fn?.();
              }}
            >
              {ws.toast.actionLabel}
            </button>
          )}
        </FrostedSurface>
      )}

      {ws.paletteOpen && (
        <CommandPalette
          threads={ws.threads}
          skills={ws.skills}
          commands={paletteCommands}
          onSelectThread={(tid) => void ws.selectThread(tid)}
          onSelectSkill={(sk) => {
            if (ws.activeThread) {
              const chip = {
                id: `skill:${sk.name}`,
                kind: 'skill' as const,
                label: `/${sk.name}`,
                skillName: sk.name,
              };
              const existing = ws.activeThread.draftChips ?? [];
              if (!existing.some((c) => c.id === chip.id)) {
                void ws.updateThread(ws.activeThread.id, {
                  draftChips: [...existing, chip],
                });
              }
            }
            ws.setCenterView('thread');
          }}
          onClose={() => ws.setPaletteOpen(false)}
        />
      )}

      {ws.shortcutsOpen && <ShortcutsModal onClose={() => ws.setShortcutsOpen(false)} />}

      {undoTargetTurnId && ws.activeThread && (
        <UndoConfirmModal
          threadId={ws.activeThread.id}
          targetTurnId={undoTargetTurnId}
          onConfirm={async () => {
            const targetThreadId = ws.activeThread?.id;
            if (!targetThreadId) return;
            const res = await window.smolcode.restoreTurnSnapshot(
              targetThreadId,
              undoTargetTurnId,
            );
            const reloaded = await window.smolcode.listTurns(targetThreadId);
            stream.setTurns(reloaded);
            handleThreadPatchLocal(targetThreadId, {
              draftText: res.restoredPrompt,
              draftChips: res.restoredChips,
            });
            setComposerRevision((r) => r + 1);
            setUndoTargetTurnId(null);
            const fileCount = res.restoredFiles.length + res.removedFiles.length;
            ws.showToast(
              `Undid ${res.turnsRemoved} turn${res.turnsRemoved === 1 ? '' : 's'} (${fileCount} file change${fileCount === 1 ? '' : 's'})`,
              {
                label: 'Revert undo',
                onAction: () => {
                  void window.smolcode
                    .revertUndoRollback(targetThreadId, res.redoId)
                    .then(async () => {
                      const restoredTurns = await window.smolcode.listTurns(targetThreadId);
                      stream.setTurns(restoredTurns);
                      setComposerRevision((r) => r + 1);
                      ws.showToast('Undo reverted');
                    });
                },
              },
            );
          }}
          onClose={() => setUndoTargetTurnId(null)}
        />
      )}

      {filePreviewTarget && (
        <FilePreviewModal
          target={filePreviewTarget}
          preferredEditor={ws.settings.preferredEditor}
          onOpenInEditor={(targetPath) => {
            void window.smolcode
              ?.openInEditor(targetPath, ws.settings.preferredEditor)
              .then((res) => {
                if (res.message) ws.showToast(res.message);
              });
          }}
          onClose={() => setFilePreviewTarget(null)}
        />
      )}
    </div>
  );
}
