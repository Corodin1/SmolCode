import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Code2, FolderOpen, Search, Sparkles, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  ApprovalRequest,
  GeneratedImageRecord,
  ProjectRecord,
  ThreadRecord,
  ToolCallLog,
  TurnRecord,
} from '../../shared/types';
import { CodexLogo } from '../Brand/CodexLogo';
import { FrostedSurface } from '../Common/FrostedSurface';
import { ApprovalCard } from './ApprovalCard';
import { TurnItem } from './TurnItem';

interface ThreadViewProps {
  project: ProjectRecord | null;
  thread: ThreadRecord | null;
  turns: TurnRecord[];
  approvals: ApprovalRequest[];
  onQuickPrompt: (prompt: string) => void;
  onOpenProject: () => void;
  onResolveApproval: (requestId: string, decision: ApprovalDecision) => void;
  onRestoreSnapshot: (turnId: string) => void;
  onForkTurn: (turnId: string) => void;
  onApprovePlan: (turnId: string) => void;
  onAnswerQuestion: (
    turnId: string,
    promptId: string,
    answers: string[],
    answersByQuestion?: Record<string, string[]>,
  ) => void;
  onEditUserPrompt: (content: string) => void;
  onPreviewFile?: (filePath: string, startLine?: number, endLine?: number) => void;
  onOpenFileInEditor?: (filePath: string) => void;
  onRetryToolError?: (tool: ToolCallLog) => void;
  onSaveGeneratedImage?: (image: GeneratedImageRecord) => Promise<void> | void;
  onCopyGeneratedImage?: (image: GeneratedImageRecord) => Promise<boolean> | boolean | void;
  onReuseImagePrompt?: (prompt: string) => void;
}

const STARTER_PROMPTS = [
  {
    icon: Code2,
    title: 'Explain codebase architecture',
    subtitle: 'Map modules, entry points, and core flows',
    prompt: 'Map the key modules, entry points, and data flow of this project.',
  },
  {
    icon: Zap,
    title: 'Find & fix bugs',
    subtitle: 'Run checks, diagnose failures, and patch cleanly',
    prompt: 'Run project checks/tests, diagnose any failures, and apply minimal fixes.',
  },
  {
    icon: Search,
    title: 'Audit code quality & edge cases',
    subtitle: 'Inspect key files for bugs, types, and error handling',
    prompt: 'Inspect the core modules in this project for bugs, edge cases, and missing checks.',
  },
  {
    icon: Sparkles,
    title: 'Plan a new feature',
    subtitle: 'Outline a concrete step-by-step plan first',
    prompt: 'Inspect the relevant architecture and propose a step-by-step plan before editing.',
  },
];

function CodexEmblem() {
  return <CodexLogo size={26} variant="glyph" />;
}

export function ThreadView({
  project,
  thread,
  turns,
  approvals,
  onQuickPrompt,
  onOpenProject,
  onResolveApproval,
  onRestoreSnapshot,
  onForkTurn,
  onApprovePlan,
  onAnswerQuestion,
  onEditUserPrompt,
  onPreviewFile,
  onOpenFileInEditor,
  onRetryToolError,
  onSaveGeneratedImage,
  onCopyGeneratedImage,
  onReuseImagePrompt,
}: ThreadViewProps) {
  'use no memo';
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);
  const isAutoScrollingRef = useRef(false);
  const rafScrollRef = useRef<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const getItemKey = useCallback(
    (index: number) => turns[index]?.id ?? index,
    [turns],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 150,
    overscan: 6,
  });

  const remeasureRow = useCallback(
    (index: number) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const rowEl = scroller.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (!rowEl || !rowEl.isConnected) return;
      const nextHeight = Math.round(rowEl.getBoundingClientRect().height || rowEl.offsetHeight);
      if (nextHeight > 0) {
        virtualizer.resizeItem(index, nextHeight);
      }
    },
    [virtualizer],
  );

  const scrollToBottom = useCallback(
    (smooth = false) => {
      const el = scrollRef.current;
      if (!el) return;
      if (rafScrollRef.current !== null) {
        cancelAnimationFrame(rafScrollRef.current);
      }
      rafScrollRef.current = requestAnimationFrame(() => {
        rafScrollRef.current = null;
        isAutoScrollingRef.current = true;
        if (turns.length > 0) {
          const lastIdx = turns.length - 1;
          const vItems = virtualizer.getVirtualItems();
          const lastRendered = vItems.some((item) => item.index === lastIdx);
          if (!lastRendered) {
            virtualizer.scrollToIndex(lastIdx, {
              align: 'end',
              behavior: smooth ? 'smooth' : 'auto',
            });
          }
        }
        if (typeof el.scrollTo === 'function') {
          el.scrollTo({
            top: el.scrollHeight,
            behavior: smooth ? 'smooth' : 'auto',
          });
        } else {
          el.scrollTop = el.scrollHeight;
        }
        requestAnimationFrame(() => {
          isAutoScrollingRef.current = false;
        });
      });
    },
    [turns.length, virtualizer],
  );

  useEffect(() => {
    return () => {
      if (rafScrollRef.current !== null) {
        cancelAnimationFrame(rafScrollRef.current);
      }
    };
  }, []);

  // Reset scroll pin on thread switch
  useEffect(() => {
    isPinnedRef.current = true;
    setShowScrollBottom(false);
    if (turns.length > 0) {
      scrollToBottom(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  // Always re-pin when user submits a new prompt
  const lastTurn = turns[turns.length - 1];
  const lastTurnRole = lastTurn?.role;
  const lastTurnId = lastTurn?.id;
  useEffect(() => {
    if (lastTurnRole === 'user') {
      isPinnedRef.current = true;
      setShowScrollBottom(false);
      scrollToBottom(false);
    }
  }, [lastTurnId, lastTurnRole, scrollToBottom]);

  // Follow streaming deltas, tool logs, thinking, and approval cards while pinned
  const lastContentLen = lastTurn?.content.length ?? 0;
  const lastThinkingLen = lastTurn?.thinking?.length ?? 0;
  const lastToolCount = lastTurn?.toolCalls?.length ?? 0;
  const lastToolDigest =
    lastTurn?.toolCalls
      ?.map((t) => `${t.id}:${t.status}:${t.summary}:${t.liveOutput?.length ?? 0}`)
      .join('|') ?? '';
  const planDigest =
    turns
      .map((t) =>
        t.plan ? `${t.plan.id}:${t.plan.steps.map((s) => s.status).join(',')}` : '',
      )
      .filter(Boolean)
      .join('|') ?? '';
  const lastTurnQuestionId = lastTurn?.questionPrompt?.id;
  const lastGeneratedImagesCount = lastTurn?.generatedImages?.length ?? 0;
  const threadApprovalsCount = approvals.filter((a) => a.threadId === thread?.id).length;

  useEffect(() => {
    if (!isPinnedRef.current || turns.length === 0) return;
    scrollToBottom(false);
  }, [
    turns.length,
    lastContentLen,
    lastThinkingLen,
    lastToolCount,
    lastToolDigest,
    lastTurn?.plan?.id,
    planDigest,
    lastTurnQuestionId,
    lastGeneratedImagesCount,
    threadApprovalsCount,
    scrollToBottom,
  ]);

  // Observe dynamic virtualized content height growth while pinned
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (isPinnedRef.current && turns.length > 0) {
        scrollToBottom(false);
      }
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [scrollToBottom, turns.length]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      isPinnedRef.current = false;
    }
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || isAutoScrollingRef.current) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom <= 36) {
      isPinnedRef.current = true;
      if (showScrollBottom) setShowScrollBottom(false);
    } else if (!isPinnedRef.current || distFromBottom > 80) {
      isPinnedRef.current = false;
      if (!showScrollBottom && distFromBottom > 80) {
        setShowScrollBottom(true);
      }
    }
  };

  if (!project || !thread) {
    return (
      <div
        className="empty-hero-stage"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 24px calc(var(--composer-dock-height, 136px) + 28px)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div className="empty-hero-glow" aria-hidden="true" />
        <div style={{ maxWidth: 420, textAlign: 'center', position: 'relative', zIndex: 1 }}>
          <div
            style={{
              width: 48,
              height: 48,
              margin: '0 auto 16px',
              borderRadius: 14,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-surface)',
              boxShadow: 'inset 0 1px 0 var(--surface-sheen)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-primary)',
            }}
          >
            <CodexEmblem />
          </div>
          <h1 style={{ margin: '0 0 8px', fontSize: 23, fontWeight: 600, letterSpacing: '-0.025em' }}>
            Let’s build
          </h1>
          <p style={{ margin: '0 0 20px', fontSize: 13.5, color: 'var(--text-secondary)' }}>
            Open a project folder to start exploring files, planning features, and shipping edits locally.
          </p>
          <button
            type="button"
            className="pressable codex-primary-btn"
            onClick={onOpenProject}
            style={{
              height: 36,
              padding: '0 18px',
              borderRadius: 10,
              border: 'none',
              background: 'var(--accent-primary)',
              color: 'var(--accent-primary-fg)',
              fontSize: 13.5,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <FolderOpen size={15} aria-hidden="true" />
            <span>Open project folder</span>
          </button>
        </div>
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div
        className="empty-hero-stage"
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 24px calc(var(--composer-dock-height, 136px) + 28px)',
          position: 'relative',
        }}
      >
        <div className="empty-hero-glow" aria-hidden="true" />
        <div style={{ width: '100%', maxWidth: 680, position: 'relative', zIndex: 1 }}>
          <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-surface)',
                  boxShadow: 'inset 0 1px 0 var(--surface-sheen)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <CodexEmblem />
              </div>
              <div>
                <h2 style={{ margin: 0, fontSize: 23, fontWeight: 600, letterSpacing: '-0.025em' }}>
                  Let’s build
                </h2>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="codex-pill" style={{ height: 24, fontSize: 12 }}>
                <FolderOpen size={12} aria-hidden="true" />
                <span>{project.name}</span>
              </span>
              {thread.interactionMode === 'plan' && (
                <span
                  className="codex-pill"
                  style={{
                    height: 24,
                    fontSize: 11.5,
                    color: 'var(--accent-blue)',
                    borderColor: 'var(--accent-blue)',
                  }}
                >
                  Plan mode
                </span>
              )}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 10,
            }}
          >
            {STARTER_PROMPTS.map((item, idx) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.title}
                  type="button"
                  className="codex-starter-card pressable hover-surface stagger-item"
                  onClick={() => onQuickPrompt(item.prompt)}
                  style={{
                    '--stagger-index': idx,
                  } as React.CSSProperties}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Icon size={14} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {item.title}
                    </span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {item.subtitle}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const isBusy =
    thread.status === 'scouting' ||
    thread.status === 'thinking' ||
    thread.status === 'verifying' ||
    thread.status === 'queued' ||
    thread.status === 'awaiting_input';

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="thread-scroll-fade-top" aria-hidden="true" />

      <div
        ref={scrollRef}
        onWheel={handleWheel}
        onTouchStart={() => {
          isPinnedRef.current = false;
        }}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px 24px calc(var(--composer-dock-height, 136px) + 24px)',
        }}
      >
        <div ref={contentRef} style={{ maxWidth: 'var(--chat-max-width, 860px)', margin: '0 auto' }}>
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vRow) => {
              const turn = turns[vRow.index];
              if (!turn) return null;
              const isLastAssistant =
                vRow.index === turns.length - 1 && turn.role === 'assistant' && isBusy;
              return (
                <div
                  key={turn.id}
                  data-index={vRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vRow.start}px)`,
                  }}
                >
                  <TurnItem
                    turn={turn}
                    turnIndex={vRow.index}
                    isStreaming={isLastAssistant}
                    canUndo={!isBusy}
                    threadStatus={isLastAssistant ? thread.status : undefined}
                    onRestoreSnapshot={onRestoreSnapshot}
                    onForkTurn={onForkTurn}
                    onApprovePlan={onApprovePlan}
                    onAnswerQuestion={onAnswerQuestion}
                    onEditUserPrompt={onEditUserPrompt}
                    onPreviewFile={onPreviewFile}
                    onOpenFileInEditor={onOpenFileInEditor}
                    onRetryToolError={onRetryToolError}
                    onSaveGeneratedImage={onSaveGeneratedImage}
                    onCopyGeneratedImage={onCopyGeneratedImage}
                    onReuseImagePrompt={onReuseImagePrompt}
                    onResizeRow={remeasureRow}
                  />
                </div>
              );
            })}
          </div>

          {approvals
            .filter((a) => a.threadId === thread.id)
            .map((req) => (
              <ApprovalCard
                key={req.id}
                request={req}
                onDecision={onResolveApproval}
              />
            ))}
        </div>
      </div>

      <div className="thread-scroll-fade-bottom" aria-hidden="true" />

      {showScrollBottom && (
        <FrostedSurface
          variant="pill"
          asButton
          cornerRadius={999}
          className="pressable hover-surface liquid-pill-enter thread-latest-pill"
          onClick={() => {
            isPinnedRef.current = true;
            setShowScrollBottom(false);
            const reduce =
              document.documentElement.getAttribute('data-reduce-motion') === 'true' ||
              window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            scrollToBottom(!reduce);
          }}
          aria-label="Scroll to latest message"
          style={{
            position: 'absolute',
          }}
        >
          <ArrowDown size={12} aria-hidden="true" />
          <span>Latest</span>
        </FrostedSurface>
      )}
    </div>
  );
}
