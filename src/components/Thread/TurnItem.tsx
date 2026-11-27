import {
  Check,
  ChevronRight,
  Copy,
  GitFork,
  RotateCcw,
} from 'lucide-react';
import { marked } from 'marked';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  GeneratedImageRecord,
  ThreadStatus,
  ToolCallLog,
  TurnRecord,
} from '../../shared/types';
import { ImageLightboxModal } from '../Modals/ImageLightboxModal';
import { ActivityTimeline } from './ActivityTimeline';
import { CodeBlock } from './CodeBlock';
import {
  GeneratedImageCard,
  GeneratingImagePlaceholder,
  parseImageAspectRatio,
} from './GeneratedImageCard';
import { PlanCard } from './PlanCard';
import { QuestionCard } from './QuestionCard';

interface TurnItemProps {
  turn: TurnRecord;
  turnIndex?: number;
  isStreaming: boolean;
  canUndo?: boolean;
  threadStatus?: ThreadStatus;
  onRestoreSnapshot?: (turnId: string) => void;
  onForkTurn?: (turnId: string) => void;
  onApprovePlan?: (turnId: string) => void;
  onAnswerQuestion?: (
    turnId: string,
    promptId: string,
    answers: string[],
    answersByQuestion?: Record<string, string[]>,
  ) => void;
  onEditUserPrompt?: (content: string) => void;
  onPreviewFile?: (filePath: string, startLine?: number, endLine?: number) => void;
  onOpenFileInEditor?: (filePath: string) => void;
  onRetryToolError?: (tool: ToolCallLog) => void;
  onSaveGeneratedImage?: (image: GeneratedImageRecord) => Promise<void> | void;
  onCopyGeneratedImage?: (image: GeneratedImageRecord) => Promise<boolean> | boolean | void;
  onReuseImagePrompt?: (prompt: string) => void;
  onResizeRow?: (turnIndex: number) => void;
  onLayoutChange?: () => void;
}

function escapeRawHtml(html: string): string {
  return html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
}

type MarkdownSegment =
  | { kind: 'html'; html: string }
  | { kind: 'code'; language: string; code: string };

function splitMarkdownSegments(raw: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const fenceRx = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  let lastIdx = 0;

  for (const m of raw.matchAll(fenceRx)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) {
      const prose = raw.slice(lastIdx, idx).trim();
      if (prose) {
        const parsed = marked.parse(prose, { async: false }) as string;
        segments.push({ kind: 'html', html: escapeRawHtml(parsed) });
      }
    }
    segments.push({
      kind: 'code',
      language: m[1] || 'text',
      code: m[2] ?? '',
    });
    lastIdx = idx + m[0].length;
  }

  if (lastIdx < raw.length) {
    const tail = raw.slice(lastIdx).trim();
    if (tail) {
      const parsed = marked.parse(tail, { async: false }) as string;
      segments.push({ kind: 'html', html: escapeRawHtml(parsed) });
    }
  }
  return segments;
}

function deriveActiveStatusLabel(
  turn: TurnRecord,
  threadStatus?: ThreadStatus,
): string {
  const runningTool = [...(turn.toolCalls ?? [])]
    .reverse()
    .find((t) => t.status === 'running');

  if (runningTool) {
    const fileBase = runningTool.filePath?.replace(/\\/g, '/').split('/').pop();
    if (runningTool.toolName === 'read_range' || runningTool.toolName === 'read_symbol') {
      return `Looking at ${fileBase ?? runningTool.summary}...`;
    }
    if (runningTool.toolName === 'read_skill') {
      return `Loading skill ${runningTool.summary}...`;
    }
    if (runningTool.toolName === 'save_skill') {
      return `Saving skill ${runningTool.summary}...`;
    }
    if (runningTool.toolName === 'generate_image') {
      return 'Generating image...';
    }
    if (runningTool.toolName === 'repo_search') {
      return `Searching ${runningTool.summary}...`;
    }
    if (runningTool.toolName === 'fast_scout') {
      return 'Scanning repository...';
    }
    if (
      runningTool.toolName === 'patch_file' ||
      runningTool.toolName === 'patch_hashline' ||
      runningTool.toolName === 'create_file'
    ) {
      return `Editing ${fileBase ?? runningTool.summary}...`;
    }
    if (runningTool.toolName === 'verify_gate') {
      return 'Verifying changes...';
    }
    if (runningTool.toolName === 'run_command') {
      return `Running ${runningTool.summary}...`;
    }
    return `Running ${runningTool.toolName}...`;
  }

  if (threadStatus === 'queued') return 'Queued...';
  if (threadStatus === 'scouting') return 'Scanning repository...';
  if (threadStatus === 'verifying') return 'Verifying changes...';
  if (threadStatus === 'awaiting_input') return 'Waiting for your response...';
  if (turn.thinking && !turn.content) return 'Thinking...';
  if (turn.content) return 'Writing response...';
  return 'Working...';
}

export function TurnItem({
  turn,
  turnIndex,
  isStreaming,
  canUndo = !isStreaming,
  threadStatus,
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
  onResizeRow,
  onLayoutChange,
}: TurnItemProps) {
  const [thinkingOverride, setThinkingOverride] = useState<boolean | null>(null);
  const [copiedTurn, setCopiedTurn] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lightboxImage, setLightboxImage] = useState<{
    image: GeneratedImageRecord;
    src: string;
  } | null>(null);

  const handleLayoutChange = useCallback(() => {
    if (turnIndex !== undefined && onResizeRow) {
      onResizeRow(turnIndex);
    } else {
      onLayoutChange?.();
    }
  }, [onLayoutChange, onResizeRow, turnIndex]);

  useEffect(() => {
    if (!isStreaming) return;
    const start = turn.createdAt || Date.now();
    const tick = () => setElapsedMs(Math.max(0, Date.now() - start));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [isStreaming, turn.createdAt]);

  const thinkingOpen = thinkingOverride ?? (isStreaming && !turn.content);

  const segments = useMemo(() => {
    if (!turn.content) return [];
    return splitMarkdownSegments(turn.content);
  }, [turn.content]);

  const copyTurnText = () => {
    void navigator.clipboard?.writeText(turn.content);
    setCopiedTurn(true);
    setTimeout(() => setCopiedTurn(false), 1500);
  };

  if (turn.role === 'user') {
    return (
      <div
        className="hover-reveal-parent"
        style={{
          padding: '10px 0 6px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 5,
        }}
      >
        <div className="codex-user-bubble">
          {turn.chips && turn.chips.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
              {turn.chips.map((c) => (
                <span
                  key={c.id}
                  className="codex-pill"
                  style={{ height: 22, fontSize: 11, background: 'var(--bg-elevated)' }}
                >
                  <span className="codex-pill-label">{c.label}</span>
                </span>
              ))}
            </div>
          )}
          {turn.content}
        </div>

        <div className="hover-reveal-actions" style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={copyTurnText}
            aria-label="Copy message"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 7px',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 11,
            }}
          >
            {copiedTurn ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
            <span>{copiedTurn ? 'Copied' : 'Copy'}</span>
          </button>
          {onEditUserPrompt && (
            <button
              type="button"
              className="pressable hover-surface"
              onClick={() => onEditUserPrompt(turn.content)}
              style={{
                padding: '2px 7px',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: 11,
              }}
            >
              Reuse
            </button>
          )}
          {canUndo && onRestoreSnapshot && (
            <button
              type="button"
              className="pressable hover-surface"
              onClick={() => onRestoreSnapshot(turn.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: 11,
              }}
            >
              <RotateCcw size={11} aria-hidden="true" />
              <span>Undo to this point</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const statusLabel = isStreaming ? deriveActiveStatusLabel(turn, threadStatus) : '';
  const runningImageTool = isStreaming
    ? [...(turn.toolCalls ?? [])].reverse().find((t) => t.toolName === 'generate_image' && t.status === 'running')
    : undefined;

  return (
    <div
      className="hover-reveal-parent"
      style={{
        padding: '8px 0 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {isStreaming && (
        <div className="ag-working-header" role="status" aria-live="polite">
          <span className="status-orb" aria-hidden="true" />
          <span className="shimmer-text" style={{ fontSize: 12.5, fontWeight: 500 }}>
            {statusLabel}
          </span>
          <span className="mono tabular-nums" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            {(elapsedMs / 1000).toFixed(1)}s
          </span>
        </div>
      )}

      {turn.thinking && (
        <div>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={() => {
              setThinkingOverride(!thinkingOpen);
              requestAnimationFrame(() => handleLayoutChange());
            }}
            aria-expanded={thinkingOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              borderRadius: 7,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <ChevronRight
              size={13}
              className="chevron-rotator"
              data-open={thinkingOpen}
              aria-hidden="true"
            />
            <span className={isStreaming && !turn.content ? 'shimmer-text' : undefined}>
              {isStreaming && !turn.content ? 'Thinking...' : 'Thought process'}
            </span>
            <span className="mono tabular-nums" style={{ fontSize: 11 }}>
              · {Math.ceil(turn.thinking.length / 4)} tok
            </span>
          </button>

          {thinkingOpen && (
            <div
              className="mono"
              style={{
                marginTop: 4,
                marginLeft: 6,
                padding: '8px 12px',
                borderLeft: '2px solid var(--border-default)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text-muted)',
                whiteSpace: 'pre-wrap',
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {turn.thinking}
            </div>
          )}
        </div>
      )}

      {turn.toolCalls && turn.toolCalls.length > 0 && (
        <ActivityTimeline
          toolCalls={turn.toolCalls}
          isStreaming={isStreaming}
          onPreviewFile={onPreviewFile}
          onOpenFileInEditor={onOpenFileInEditor}
          onRetryToolError={onRetryToolError}
          onLayoutChange={handleLayoutChange}
        />
      )}

      {turn.questionPrompt && (
        <QuestionCard
          prompt={turn.questionPrompt}
          onSubmitAnswer={(answers, answersByQuestion) =>
            onAnswerQuestion?.(
              turn.id,
              turn.questionPrompt!.id,
              answers,
              answersByQuestion,
            )
          }
        />
      )}

      {turn.plan && (
        <PlanCard
          plan={turn.plan}
          disabled={isStreaming}
          onApproveAndImplement={() => onApprovePlan?.(turn.id)}
        />
      )}

      {runningImageTool && (
        <GeneratingImagePlaceholder
          prompt={runningImageTool.summary}
          aspectRatio={parseImageAspectRatio(runningImageTool.argsPreview)}
          onLayoutChange={handleLayoutChange}
        />
      )}

      {turn.generatedImages && turn.generatedImages.length > 0 && (
        <div className="chatgpt-image-grid">
          {turn.generatedImages.map((img) => (
            <GeneratedImageCard
              key={img.id}
              image={img}
              onExpand={(targetImg, src) => setLightboxImage({ image: targetImg, src })}
              onSaveToWorkspace={onSaveGeneratedImage}
              onCopyImage={onCopyGeneratedImage}
              onReusePrompt={onReuseImagePrompt}
              onLayoutChange={handleLayoutChange}
            />
          ))}
        </div>
      )}

      {lightboxImage && (
        <ImageLightboxModal
          image={lightboxImage.image}
          src={lightboxImage.src}
          onSaveToWorkspace={onSaveGeneratedImage}
          onCopyImage={onCopyGeneratedImage}
          onClose={() => setLightboxImage(null)}
        />
      )}

      {turn.content ? (
        <div className="codex-markdown">
          {segments.map((seg, idx) =>
            seg.kind === 'code' ? (
              <CodeBlock key={idx} code={seg.code} language={seg.language} />
            ) : (
              <div key={idx} dangerouslySetInnerHTML={{ __html: seg.html }} />
            ),
          )}
        </div>
      ) : null}

      {!isStreaming && (
        <div
          className="hover-reveal-actions"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--text-muted)',
          }}
        >
          {turn.content && (
            <button
              type="button"
              className="pressable hover-surface"
              onClick={copyTurnText}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                borderRadius: 6,
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 11.5,
              }}
            >
              {copiedTurn ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
              <span>{copiedTurn ? 'Copied' : 'Copy'}</span>
            </button>
          )}

          {turn.telemetry && (
            <span className="mono tabular-nums" style={{ fontSize: 11 }}>
              {turn.telemetry.mainModelUsed.split(':')[0]} · {turn.telemetry.evalTokensPerSec} tok/s
            </span>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            {canUndo && onRestoreSnapshot && (
              <button
                type="button"
                className="pressable hover-surface"
                onClick={() => onRestoreSnapshot(turn.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 7px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  fontSize: 11.5,
                }}
              >
                <RotateCcw size={11} aria-hidden="true" />
                <span>Undo to this point</span>
              </button>
            )}
            {onForkTurn && (
              <button
                type="button"
                className="pressable hover-surface"
                onClick={() => onForkTurn(turn.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 7px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  fontSize: 11.5,
                }}
              >
                <GitFork size={11} aria-hidden="true" />
                <span>Fork</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
