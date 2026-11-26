// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/Composer/Composer';
import { ComposerBar } from '../../src/components/Composer/ComposerBar';
import { EffortSlider } from '../../src/components/Composer/EffortSlider';
import { FrostedSurface } from '../../src/components/Common/FrostedSurface';
import { resolveWindowMaterial } from '../../src/shared/theme-presets';
import { CommandPalette } from '../../src/components/Modals/CommandPalette';
import { UndoConfirmModal } from '../../src/components/Modals/UndoConfirmModal';
import { ActivityTimeline } from '../../src/components/Thread/ActivityTimeline';
import { PlanCard } from '../../src/components/Thread/PlanCard';
import { QuestionCard } from '../../src/components/Thread/QuestionCard';
import { ThreadView } from '../../src/components/Thread/ThreadView';
import { TurnItem } from '../../src/components/Thread/TurnItem';
import { SettingsView } from '../../src/components/Views/SettingsView';
import { SkillsView } from '../../src/components/Views/SkillsView';
import { DEFAULT_APP_SETTINGS } from '../../src/state/defaults';
import type { OllamaModelInfo, ThreadRecord } from '../../src/shared/types';

afterEach(() => {
  cleanup();
});

const SAMPLE_THREAD: ThreadRecord = {
  id: 't1',
  projectId: 'p1',
  title: 'Fix auth token expiry',
  interactionMode: 'build',
  mainModel: 'qwen3.5:9b',
  fastModel: 'qwen3:1.7b',
  effort: 'medium',
  approvalPolicy: 'auto',
  draftText: '',
  draftChips: [],
  queuedPrompts: [],
  status: 'idle',
  unread: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};

const SAMPLE_MODELS: OllamaModelInfo[] = [
  {
    name: 'qwen3.5:9b',
    sizeBytes: 6550811412,
    parameterSize: '9.0B',
    quantizationLevel: 'Q4_K_M',
    capabilities: { tools: true, thinking: true, vision: true },
    contextLength: 262144,
  },
  {
    name: 'llama3.3:70b',
    sizeBytes: 42000000000,
    parameterSize: '70B',
    quantizationLevel: 'Q4_K_M',
    capabilities: { tools: true, thinking: false, vision: false },
    contextLength: 131072,
  },
];

describe('SmolCode UI components', () => {
  it('switches Build/Plan mode, Model, and Effort in ComposerBar without git controls', () => {
    const onUpdate = vi.fn();
    render(
      <ComposerBar
        thread={SAMPLE_THREAD}
        models={SAMPLE_MODELS}
        vram={{ totalMb: 8192, freeMb: 4096, loadedModels: [] }}
        latestTelemetry={null}
        showAdvancedDualModel={false}
        pinFastToCpu={false}
        activeContextTokens={3200}
        contextBudget={16384}
        isBusy={false}
        canSend={true}
        followUpMode="queue"
        recording={false}
        transcribing={false}
        onToggleFollowUpMode={vi.fn()}
        onToggleRecording={vi.fn()}
        onAttachFiles={vi.fn()}
        onOpenSkills={vi.fn()}
        onCompactThread={vi.fn()}
        onUpdateThread={onUpdate}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.queryByTitle(/Base branch:/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Environment:/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/Toggle Build \/ Plan mode/i));
    expect(onUpdate).toHaveBeenCalledWith({ interactionMode: 'plan' });

    fireEvent.click(screen.getByTitle(/Reasoning Effort: Medium/i));
    fireEvent.click(screen.getByRole('button', { name: 'Ultra' }));
    expect(onUpdate).toHaveBeenCalledWith({ effort: 'xhigh' });

    fireEvent.click(screen.getByTitle(/^Model:/i));
    fireEvent.click(screen.getByText('llama3.3:70b'));
    expect(onUpdate).toHaveBeenCalledWith({
      mainModel: 'llama3.3:70b',
      fastModel: 'llama3.3:70b',
    });
  });

  it('renders Antigravity-style live file inspection pills, active TurnItem status, and Plan/Question cards', () => {
    const onApprove = vi.fn();
    const onAnswer = vi.fn();
    render(
      <div>
        <TurnItem
          isStreaming={true}
          threadStatus="thinking"
          turn={{
            id: 'turn-live',
            threadId: 't1',
            role: 'assistant',
            content: '',
            createdAt: Date.now(),
            toolCalls: [
              {
                id: 'r1',
                toolName: 'read_range',
                summary: 'src/auth.ts L1-90',
                argsPreview: '{}',
                status: 'running',
                filePath: 'src/auth.ts',
              },
            ],
          }}
        />
        <ActivityTimeline
          toolCalls={[
            {
              id: '1',
              toolName: 'repo_search',
              summary: '"auth"',
              argsPreview: '{}',
              status: 'ok',
              filePath: 'src/auth.ts',
            },
            {
              id: '2',
              toolName: 'read_symbol',
              summary: 'src/session.ts::login',
              argsPreview: '{}',
              status: 'ok',
              filePath: 'src/session.ts',
            },
            {
              id: '3',
              toolName: 'patch_file',
              summary: 'src/auth.ts',
              argsPreview: '{}',
              status: 'ok',
              filePath: 'src/auth.ts',
              linesAdded: 4,
              linesRemoved: 1,
            },
          ]}
        />
        <PlanCard
          plan={{
            id: 'p1',
            title: 'Refactor auth session',
            summary: 'Update token TTL cleanly',
            steps: [{ id: 's1', title: 'Update ttl constant', status: 'pending' }],
          }}
          onApproveAndImplement={onApprove}
        />
        <QuestionCard
          prompt={{
            id: 'q1',
            question: 'Which storage backend?',
            options: [{ label: 'SQLite' }, { label: 'Postgres' }],
            allowCustom: true,
          }}
          onSubmitAnswer={onAnswer}
        />
      </div>,
    );

    expect(screen.getByText('Looking at auth.ts...')).toBeInTheDocument();
    expect(screen.getByText('Analyzed 2 files')).toBeInTheDocument();
    expect(screen.getByText('session.ts')).toBeInTheDocument();
    expect(screen.getByText('Edited')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Implement plan'));
    expect(onApprove).toHaveBeenCalled();

    fireEvent.click(screen.getByText('SQLite'));
    expect(onAnswer).toHaveBeenCalledWith(['SQLite']);
  });

  it('supports Appearance Studio theme presets, accent swatches, density, and glass settings', async () => {
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        tab="appearance"
        onChangeTab={vi.fn()}
        settings={DEFAULT_APP_SETTINGS}
        models={SAMPLE_MODELS}
        vram={{ totalMb: 8192, freeMb: 4096, loadedModels: [] }}
        projects={[]}
        activeProject={null}
        mcpServers={[]}
        onBack={vi.fn()}
        onSaveSettings={onSaveSettings}
        onRefreshModels={vi.fn().mockResolvedValue(undefined)}
        onSaveMcpServer={vi.fn().mockResolvedValue(undefined)}
        onDeleteMcpServer={vi.fn().mockResolvedValue(undefined)}
        onTestMcpServer={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText('Git & Worktrees')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Midnight Slate'));
    });
    expect(onSaveSettings).toHaveBeenCalledWith({ themePreset: 'midnight', theme: 'dark' });

    await act(async () => {
      fireEvent.click(screen.getByText('Violet'));
    });
    expect(onSaveSettings).toHaveBeenCalledWith({ accentColor: 'violet' });

    await act(async () => {
      fireEvent.click(screen.getByText('compact'));
    });
    expect(onSaveSettings).toHaveBeenCalledWith({ uiDensity: 'compact' });

    await act(async () => {
      fireEvent.click(screen.getByText('rich'));
    });
    expect(onSaveSettings).toHaveBeenCalledWith({ glassIntensity: 'rich' });
  });

  it('renders ThreadView empty state without git copy and exposes Latest pill when scrolled up', () => {
    const { rerender } = render(
      <ThreadView
        project={{ id: 'p1', name: 'DemoApp', rootPath: 'C:/tmp/demo', createdAt: 1 }}
        thread={SAMPLE_THREAD}
        turns={[]}
        approvals={[]}
        onQuickPrompt={vi.fn()}
        onOpenProject={vi.fn()}
        onResolveApproval={vi.fn()}
        onRestoreSnapshot={vi.fn()}
        onForkTurn={vi.fn()}
        onApprovePlan={vi.fn()}
        onAnswerQuestion={vi.fn()}
        onEditUserPrompt={vi.fn()}
      />,
    );

    expect(screen.getByText('Audit code quality & edge cases')).toBeInTheDocument();
    expect(screen.queryByText('Review local diff')).not.toBeInTheDocument();

    rerender(
      <ThreadView
        project={{ id: 'p1', name: 'DemoApp', rootPath: 'C:/tmp/demo', createdAt: 1 }}
        thread={SAMPLE_THREAD}
        turns={[
          { id: 'u1', threadId: 't1', role: 'user', content: 'Hello', createdAt: 1 },
          { id: 'a1', threadId: 't1', role: 'assistant', content: 'World', createdAt: 2 },
        ]}
        approvals={[]}
        onQuickPrompt={vi.fn()}
        onOpenProject={vi.fn()}
        onResolveApproval={vi.fn()}
        onRestoreSnapshot={vi.fn()}
        onForkTurn={vi.fn()}
        onApprovePlan={vi.fn()}
        onAnswerQuestion={vi.fn()}
        onEditUserPrompt={vi.fn()}
      />,
    );

    const scrollContainer = document.querySelector('[style*="overflow-y: auto"]') as HTMLDivElement;
    expect(scrollContainer).toBeTruthy();
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 200, configurable: true, writable: true });

    fireEvent.wheel(scrollContainer, { deltaY: -120 });
    fireEvent.scroll(scrollContainer);
    expect(screen.getByLabelText('Scroll to latest message')).toBeInTheDocument();
  });

  it('filters and runs commands inside instant CommandPalette and renders SettingsView MCP tab', () => {
    const onSelectThread = vi.fn();
    const onClose = vi.fn();
    render(
      <div>
        <CommandPalette
          threads={[SAMPLE_THREAD]}
          commands={[{ id: 'c1', label: 'Toggle Sidebar', group: 'View', run: vi.fn() }]}
          onSelectThread={onSelectThread}
          onClose={onClose}
        />
        <SettingsView
          tab="mcp"
          onChangeTab={vi.fn()}
          settings={DEFAULT_APP_SETTINGS}
          models={SAMPLE_MODELS}
          vram={{ totalMb: 8192, freeMb: 4096, loadedModels: [] }}
          projects={[]}
          activeProject={null}
          mcpServers={[]}
          onBack={vi.fn()}
          onSaveSettings={async () => {}}
          onRefreshModels={async () => {}}
          onSaveMcpServer={async () => {}}
          onDeleteMcpServer={async () => {}}
          onTestMcpServer={async () => {}}
        />
      </div>,
    );

    const input = screen.getByLabelText('Search commands and threads');
    fireEvent.change(input, { target: { value: 'auth token' } });
    fireEvent.click(screen.getByText('Fix auth token expiry'));
    expect(onSelectThread).toHaveBeenCalledWith('t1');

    expect(screen.getByText('Add MCP server')).toBeInTheDocument();
  });

  it('renders live command output, interactive file pills, Retry/Fix action, PlanCard progress, and Obscura settings', async () => {
    const onPreviewFile = vi.fn();
    const onOpenFileInEditor = vi.fn();
    const onRetryToolError = vi.fn();
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);

    render(
      <div>
        <ActivityTimeline
          isStreaming={true}
          onPreviewFile={onPreviewFile}
          onOpenFileInEditor={onOpenFileInEditor}
          onRetryToolError={onRetryToolError}
          toolCalls={[
            {
              id: 't-read',
              toolName: 'read_range',
              summary: 'src/app.ts L10-20',
              argsPreview: '{}',
              filePath: 'src/app.ts',
              status: 'ok',
              durationMs: 4,
            },
            {
              id: 't-cmd',
              toolName: 'run_command',
              summary: 'npm test',
              argsPreview: '{"command":"npm test"}',
              liveOutput: 'RUN v5.1.1\nPASS tests/a.test.ts',
              status: 'running',
            },
            {
              id: 't-err',
              toolName: 'patch_hashline',
              summary: 'src/broken.ts',
              argsPreview: '{}',
              resultPreview: 'Anchor mismatch at 10:aa',
              filePath: 'src/broken.ts',
              status: 'error',
              durationMs: 8,
            },
          ]}
        />
        <PlanCard
          plan={{
            id: 'p1',
            title: 'Upgrade agent',
            summary: 'Live steps',
            approved: true,
            steps: [
              { id: 'step-1', title: 'Read files', status: 'done' },
              { id: 'step-2', title: 'Patch code', status: 'in_progress' },
            ],
          }}
          onApproveAndImplement={vi.fn()}
        />
        <SettingsView
          tab="general"
          onChangeTab={vi.fn()}
          settings={DEFAULT_APP_SETTINGS}
          models={SAMPLE_MODELS}
          vram={{ totalMb: 8192, freeMb: 4096, loadedModels: [] }}
          projects={[]}
          activeProject={null}
          mcpServers={[]}
          onBack={vi.fn()}
          onSaveSettings={onSaveSettings}
          onRefreshModels={vi.fn().mockResolvedValue(undefined)}
          onSaveMcpServer={vi.fn().mockResolvedValue(undefined)}
          onDeleteMcpServer={vi.fn().mockResolvedValue(undefined)}
          onTestMcpServer={vi.fn().mockResolvedValue(undefined)}
        />
      </div>,
    );

    // Live command output visible while running
    expect(screen.getByText(/PASS tests\/a\.test\.ts/)).toBeInTheDocument();

    // Clicking file pill triggers preview; Ctrl+Click opens in external editor
    const pill = screen.getByRole('button', { name: 'Preview src/app.ts' });
    fireEvent.click(pill);
    expect(onPreviewFile).toHaveBeenCalledWith('src/app.ts', 10, 20);
    fireEvent.click(pill, { ctrlKey: true });
    expect(onOpenFileInEditor).toHaveBeenCalledWith('src/app.ts');

    // One-click Retry / Fix on failed tool
    fireEvent.click(screen.getByRole('button', { name: 'Retry / Fix' }));
    expect(onRetryToolError).toHaveBeenCalledWith(expect.objectContaining({ id: 't-err' }));

    // PlanCard shows progress counter & active step status
    expect(screen.getByText('1/2 steps')).toBeInTheDocument();
    expect(screen.getByText('Patch code').closest('li')).toHaveAttribute('data-status', 'in_progress');

    // Obscura toggle in SettingsView
    const toggle = screen.getByLabelText(/Internet Lookup via Obscura/i);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(onSaveSettings).toHaveBeenCalledWith({ webLookupEnabled: false });
  });

  it('attaches clean skill chips via Composer SlashMenu and supports SkillsView scopes, delete, and Generate with AI', async () => {
    const onUpdateThread = vi.fn();
    const onDeleteSkill = vi.fn().mockResolvedValue(undefined);
    const onGenerateWithAi = vi.fn();

    const sampleSkills = [
      {
        id: 'sk-repo',
        name: 'smolcode-testing',
        description: 'Vitest conventions',
        sourcePath: 'C:/repo/.smolcode/skills/smolcode-testing/SKILL.md',
        scope: 'repo' as const,
        content: 'Run npm test.',
        tags: ['testing'],
      },
      {
        id: 'sk-bi',
        name: 'skill-creator',
        description: 'Author skills',
        sourcePath: 'builtin://skill-creator/SKILL.md',
        scope: 'builtin' as const,
        content: 'Use save_skill.',
      },
    ];

    render(
      <div>
        <Composer
          thread={SAMPLE_THREAD}
          models={SAMPLE_MODELS}
          skills={sampleSkills}
          vram={{ totalMb: 8192, freeMb: 4096, loadedModels: [] }}
          latestTelemetry={null}
          showAdvancedDualModel={false}
          pinFastToCpu={false}
          activeContextTokens={100}
          contextBudget={8192}
          onUpdateThread={onUpdateThread}
          onSendPrompt={vi.fn()}
          onSteerThread={vi.fn()}
          onEnqueuePrompt={vi.fn()}
          onRemoveQueuedPrompt={vi.fn()}
          onStopThread={vi.fn()}
          onSlashAction={vi.fn()}
          onAttachFiles={vi.fn()}
          onOpenSkills={vi.fn()}
        />
        <SkillsView
          project={{ id: 'p1', name: 'SmolCode', rootPath: 'C:/repo', createdAt: 1 }}
          skills={sampleSkills}
          onBack={vi.fn()}
          onUseSkill={vi.fn()}
          onCreateSkill={vi.fn().mockResolvedValue(undefined)}
          onUpdateSkill={vi.fn().mockResolvedValue(undefined)}
          onDeleteSkill={onDeleteSkill}
          onGenerateWithAi={onGenerateWithAi}
        />
      </div>,
    );

    const textarea = screen.getByLabelText('Prompt composer');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '/smolcode' } });
    });

    const option = screen.getByRole('option', { name: /\/smolcode-testing/i });
    fireEvent.click(option);
    expect(onUpdateThread).toHaveBeenCalledWith({
      draftChips: [
        {
          id: 'skill:smolcode-testing',
          kind: 'skill',
          label: '/smolcode-testing',
          skillName: 'smolcode-testing',
        },
      ],
      draftText: '',
    });

    // SkillsView filter & actions
    fireEvent.click(screen.getByRole('button', { name: 'Generate with AI' }));
    expect(onGenerateWithAi).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete skill smolcode-testing' }));
    expect(onDeleteSkill).toHaveBeenCalledWith(
      'C:/repo/.smolcode/skills/smolcode-testing/SKILL.md',
      'p1',
    );
  });

  it('supports TurnItem Undo triggers, multi-question Antigravity QuestionCard, and UndoConfirmModal diff preview', async () => {
    const onUndoTrigger = vi.fn();
    const onAnswer = vi.fn();
    const onConfirmUndo = vi.fn().mockResolvedValue(undefined);

    const prevSmolcode = window.smolcode;
    (window as unknown as { smolcode: unknown }).smolcode = {
      previewUndoToTurn: vi.fn().mockResolvedValue({
        threadId: 't1',
        targetTurnId: 'u-1',
        rollbackStartTurnId: 'u-1',
        hasSnapshot: true,
        snapshotId: 'snap-1',
        restoredPrompt: 'Refactor auth check',
        restoredChips: [],
        turnsToRemoveCount: 2,
        fileChanges: [
          {
            path: 'src/auth.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            lines: [
              { kind: 'remove', oldLine: 10, text: 'return false;' },
              { kind: 'add', newLine: 10, text: 'return true;' },
            ],
          },
        ],
      }),
    };

    try {
      render(
        <div>
          <TurnItem
            isStreaming={false}
            canUndo={true}
            onRestoreSnapshot={onUndoTrigger}
            turn={{
              id: 'u-1',
              threadId: 't1',
              role: 'user',
              content: 'Refactor auth check',
              createdAt: 100,
            }}
          />
          <TurnItem
            isStreaming={false}
            canUndo={true}
            onRestoreSnapshot={onUndoTrigger}
            turn={{
              id: 'a-1',
              threadId: 't1',
              role: 'assistant',
              content: 'Completed',
              createdAt: 101,
            }}
          />
          <QuestionCard
            prompt={{
              id: 'q-multi',
              question: 'Confirm confirmation style?',
              options: [
                { label: '(Recommended) Preview modal', description: 'Show file diffs first' },
                { label: 'Immediate undo' },
              ],
              allowCustom: true,
              questions: [
                {
                  id: 'q-style',
                  question: 'Confirm confirmation style?',
                  options: [
                    { label: '(Recommended) Preview modal', description: 'Show file diffs first' },
                    { label: 'Immediate undo' },
                  ],
                  allowCustom: true,
                },
                {
                  id: 'q-triggers',
                  question: 'Which triggers to include?',
                  multiSelect: true,
                  options: [
                    { label: 'User turns' },
                    { label: 'Assistant turns' },
                  ],
                  allowCustom: true,
                },
              ],
            }}
            onSubmitAnswer={onAnswer}
          />
          <UndoConfirmModal
            threadId="t1"
            targetTurnId="u-1"
            onConfirm={onConfirmUndo}
            onClose={vi.fn()}
          />
        </div>,
      );

      // TurnItem shows "Undo to this point" on both user and assistant turns
      const undoBtns = screen.getAllByRole('button', { name: /Undo to this point/i });
      expect(undoBtns.length).toBeGreaterThanOrEqual(2);
      fireEvent.click(undoBtns[0]);
      expect(onUndoTrigger).toHaveBeenCalledWith('u-1');

      // Multi-question QuestionCard shows Step indicator & Recommended badge
      expect(screen.getByText('Question 1 of 2')).toBeInTheDocument();
      expect(screen.getByText('Recommended')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Preview modal'));

      // Advances automatically to Question 2 (multiSelect checkboxes)
      expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();
      expect(screen.getByText('Select multiple')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: /User turns/i }));
      fireEvent.click(screen.getByRole('checkbox', { name: /Assistant turns/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
      expect(onAnswer).toHaveBeenCalledWith(
        [
          'Confirm confirmation style?: (Recommended) Preview modal',
          'Which triggers to include?: User turns, Assistant turns',
        ],
        {
          'q-style': ['(Recommended) Preview modal'],
          'q-triggers': ['User turns', 'Assistant turns'],
        },
      );

      // UndoConfirmModal displays fetched file diff & confirms
      expect(await screen.findByText('src/auth.ts')).toBeInTheDocument();
      expect(screen.getByText('return false;')).toBeInTheDocument();
      expect(screen.getByText('2 turns removed')).toBeInTheDocument();
      const dialog = screen.getByRole('dialog');
      const modalConfirm = within(dialog).getByRole('button', {
        name: 'Undo to this point',
      });
      await act(async () => {
        fireEvent.click(modalConfirm);
      });
      expect(onConfirmUndo).toHaveBeenCalledTimes(1);
    } finally {
      (window as unknown as { smolcode: unknown }).smolcode = prevSmolcode;
    }
  });

  it('renders FrostedSurface variants and resolves Windows Acrylic material by glassIntensity and preset', () => {
    const onPillClick = vi.fn();

    render(
      <div>
        <FrostedSurface variant="composer" cornerRadius={22} aria-label="Floating composer">
          <span>Composer content</span>
        </FrostedSurface>
        <FrostedSurface
          variant="pill"
          cornerRadius={999}
          asButton
          onClick={onPillClick}
          aria-label="Latest pill"
        >
          <span>Latest</span>
        </FrostedSurface>
      </div>,
    );

    const composerSurface = screen.getByLabelText('Floating composer');
    expect(composerSurface).toHaveAttribute('data-frosted-variant', 'composer');
    expect(composerSurface).toHaveClass('codex-frosted-surface');

    const pillButton = screen.getByRole('button', { name: 'Latest pill' });
    expect(pillButton).toHaveAttribute('data-frosted-variant', 'pill');
    fireEvent.click(pillButton);
    expect(onPillClick).toHaveBeenCalledTimes(1);

    const acrylicDark = resolveWindowMaterial('dark', 'obsidian', 'subtle', true);
    expect(acrylicDark.useAcrylic).toBe(true);
    expect(acrylicDark.backgroundColor).toBe('#00000000');
    expect(acrylicDark.overlayColor).toBe('#00000000');

    const acrylicOff = resolveWindowMaterial('light', 'alabaster', 'off', false);
    expect(acrylicOff.useAcrylic).toBe(false);
    expect(acrylicOff.backgroundColor).toBe('#ffffff');
    expect(acrylicOff.overlayColor).toBe('#f7f7f8');

    const highContrast = resolveWindowMaterial('dark', 'high-contrast', 'rich', true);
    expect(highContrast.useAcrylic).toBe(false);
    expect(highContrast.backgroundColor).toBe('#070709');
  });

  it('surfaces failed read_range / explore calls as visible Tool failed diagnostics instead of collapsing silently', () => {
    render(
      <ActivityTimeline
        toolCalls={[
          {
            id: 'r1',
            toolName: 'read_range',
            summary: 'main.py L105-145',
            argsPreview: '{}',
            resultPreview: 'File: main.py',
            status: 'ok',
            durationMs: 1,
            filePath: 'main.py',
          },
          {
            id: 'r2',
            toolName: 'read_range',
            summary: 'main.py L105-145',
            argsPreview: '{}',
            resultPreview: 'LoopGuard: "read_range" was already called on this unchanged workspace state.',
            status: 'error',
            durationMs: 0,
            filePath: 'main.py',
          },
          {
            id: 'r3',
            toolName: 'read_range',
            summary: 'main.py L1-20',
            argsPreview: '{}',
            resultPreview: 'File: main.py',
            status: 'ok',
            durationMs: 1,
            filePath: 'main.py',
          },
        ]}
      />,
    );

    expect(screen.getByText('Tool failed')).toBeInTheDocument();
    expect(screen.getByText(/already called on this unchanged workspace state/i)).toBeInTheDocument();
  });

  it('supports Codex-style EffortSlider keyboard & drag interactions, Create image mode, and ChatGPT image cards + lightbox', async () => {
    const onUpdateThread = vi.fn();
    const onChangeSize = vi.fn();
    const onSaveImage = vi.fn().mockResolvedValue(undefined);
    const onCopyImage = vi.fn().mockResolvedValue(true);
    const onReusePrompt = vi.fn();

    render(
      <div>
        <ComposerBar
          thread={{
            ...SAMPLE_THREAD,
            draftChips: [
              {
                id: 'skill:image-gen',
                kind: 'skill',
                label: '/image-gen',
                skillName: 'image-gen',
              },
            ],
          }}
          models={SAMPLE_MODELS}
          vram={{ totalMb: 8192, freeMb: 4096, loadedModels: [] }}
          latestTelemetry={null}
          showAdvancedDualModel={false}
          pinFastToCpu={false}
          activeContextTokens={1200}
          contextBudget={16384}
          isBusy={false}
          canSend={true}
          followUpMode="queue"
          recording={false}
          transcribing={false}
          imageGenSize="1024x1024"
          onChangeImageGenSize={onChangeSize}
          onToggleFollowUpMode={vi.fn()}
          onToggleRecording={vi.fn()}
          onAttachFiles={vi.fn()}
          onOpenSkills={vi.fn()}
          onCompactThread={vi.fn()}
          onUpdateThread={onUpdateThread}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
        <TurnItem
          isStreaming={true}
          threadStatus="thinking"
          turn={{
            id: 'turn-img-streaming',
            threadId: 't1',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'img-tool-1',
                toolName: 'generate_image',
                summary: 'Minimalist glass prism',
                argsPreview: '{"prompt":"Minimalist glass prism"}',
                status: 'running',
              },
            ],
            createdAt: Date.now(),
          }}
        />
        <TurnItem
          isStreaming={false}
          turn={{
            id: 'turn-img-done',
            threadId: 't1',
            role: 'assistant',
            content: 'Generated your prism artwork.',
            generatedImages: [
              {
                id: 'gen-1',
                threadId: 't1',
                turnId: 'turn-img-done',
                prompt: 'Minimalist glass prism on dark obsidian desk',
                filePath: 'C:\\tmp\\prism.png',
                dataUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW0cAAAAASUVORK5CYII=',
                width: 1024,
                height: 1024,
                steps: 8,
                seed: 12345,
                model: 'x/flux2-klein',
                backend: 'ollama',
                durationMs: 2400,
                createdAt: Date.now(),
              },
            ],
            createdAt: Date.now(),
          }}
          onSaveGeneratedImage={onSaveImage}
          onCopyGeneratedImage={onCopyImage}
          onReuseImagePrompt={onReusePrompt}
        />
      </div>,
    );

    // Codex Effort Slider keyboard stepping
    fireEvent.click(screen.getByTitle(/Reasoning Effort: Medium/i));
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' });
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onUpdateThread).toHaveBeenCalledWith({ effort: 'high' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onUpdateThread).toHaveBeenCalledWith({ effort: 'xhigh' });
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onUpdateThread).toHaveBeenCalledWith({ effort: 'low' });

    // Inline aspect ratio selector when Create image is active
    fireEvent.click(screen.getByTitle(/Image size: Square/i));
    fireEvent.click(screen.getByText(/Landscape \(1024×576\)/i));
    expect(onChangeSize).toHaveBeenCalledWith('1024x576');

    // Generating placeholder procedural ocean canvas (no text, no icons) + completed image card + lightbox
    const generatingStatus = screen.getByRole('status', { name: 'Generating image' });
    expect(generatingStatus).toBeInTheDocument();
    expect(generatingStatus.textContent).toBe('');
    expect(generatingStatus.querySelector('svg')).toBeNull();
    expect(generatingStatus.querySelector('canvas.gemini-ocean-canvas')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save image to workspace' }));
      await Promise.resolve();
    });
    expect(onSaveImage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Reuse image prompt' }));
    expect(onReusePrompt).toHaveBeenCalledWith('Minimalist glass prism on dark obsidian desk');

    fireEvent.click(
      screen.getByRole('button', { name: /Inspect generated image: Minimalist glass prism/i }),
    );
    const lightbox = screen.getByRole('dialog', { name: 'Generated image preview' });
    expect(lightbox).toBeInTheDocument();
    expect(within(lightbox).getByText(/Backend: ollama/i)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).not.toBeInTheDocument();
  });

  it('renders animated cosmic starfield on Ultra effort mode and inline description in Settings variant', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <EffortSlider variant="popover" value="low" onChange={onChange} />,
    );

    expect(screen.getByRole('slider', { name: 'Reasoning effort' })).toHaveAttribute(
      'aria-valuetext',
      'Low',
    );
    expect(container.querySelector('.codex-effort-stars')).not.toBeInTheDocument();
    expect(container.querySelector('.codex-effort-footer')).not.toBeInTheDocument();

    rerender(<EffortSlider variant="inline" value="xhigh" onChange={onChange} />);
    expect(screen.getByRole('slider', { name: 'Reasoning effort' })).toHaveAttribute(
      'aria-valuetext',
      'Ultra',
    );
    expect(container.querySelector('.codex-effort-stars')).toBeInTheDocument();
    expect(container.querySelectorAll('.codex-effort-star').length).toBeGreaterThan(0);
    expect(screen.getByText(/Ultra · 6\.1k tok/i)).toBeInTheDocument();
  });
});
