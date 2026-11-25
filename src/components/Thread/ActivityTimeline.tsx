import {
  CheckCircle2,
  ChevronRight,
  Eye,
  FileCode2,
  FileEdit,
  Globe,
  Loader2,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import type { ToolCallLog } from '../../shared/types';

interface ActivityTimelineProps {
  toolCalls: ToolCallLog[];
  isStreaming?: boolean;
  onPreviewFile?: (filePath: string, startLine?: number, endLine?: number) => void;
  onOpenFileInEditor?: (filePath: string) => void;
  onRetryToolError?: (tool: ToolCallLog) => void;
  onLayoutChange?: () => void;
}

type TimelineGroup =
  | { kind: 'explore-group'; id: string; items: ToolCallLog[] }
  | { kind: 'single'; id: string; item: ToolCallLog };

const EXPLORE_TOOLS = new Set([
  'repo_search',
  'read_symbol',
  'read_range',
  'fast_scout',
  'list_dir',
  'find_files',
  'web_lookup',
  'read_skill',
]);

function extractBasename(filePath: string): string {
  const clean = filePath.replace(/\\/g, '/');
  return clean.split('/').pop() || clean;
}

function extractLineRange(summary: string): string | null {
  const lineMatch = summary.match(/\bL(\d+-\d+)\b/);
  if (lineMatch) return `#L${lineMatch[1]}`;
  const symMatch = summary.match(/::([A-Za-z0-9_$.]+)/);
  if (symMatch) return `::${symMatch[1]}`;
  return null;
}

function parseNumericRange(rangeLabel?: string | null): { startLine?: number; endLine?: number } {
  if (!rangeLabel) return {};
  const m = rangeLabel.match(/^#L(\d+)-(\d+)$/);
  if (!m) return {};
  return { startLine: Number(m[1]), endLine: Number(m[2]) };
}

function groupTools(tools: ToolCallLog[], isStreaming: boolean): TimelineGroup[] {
  const out: TimelineGroup[] = [];
  let runBuffer: ToolCallLog[] = [];

  const flushRun = () => {
    if (runBuffer.length === 0) return;
    if (isStreaming) {
      const overflow = runBuffer.length - 4;
      if (overflow >= 2 && runBuffer.slice(0, overflow).every((t) => t.status !== 'running')) {
        out.push({
          kind: 'explore-group',
          id: `grp-${runBuffer[0].id}`,
          items: runBuffer.slice(0, overflow),
        });
        for (const t of runBuffer.slice(overflow)) {
          out.push({ kind: 'single', id: t.id, item: t });
        }
      } else {
        for (const t of runBuffer) {
          out.push({ kind: 'single', id: t.id, item: t });
        }
      }
    } else if (runBuffer.length >= 2) {
      out.push({
        kind: 'explore-group',
        id: `grp-${runBuffer[0].id}`,
        items: [...runBuffer],
      });
    } else {
      out.push({ kind: 'single', id: runBuffer[0].id, item: runBuffer[0] });
    }
    runBuffer = [];
  };

  for (const t of tools) {
    if (EXPLORE_TOOLS.has(t.toolName)) {
      runBuffer.push(t);
    } else {
      flushRun();
      out.push({ kind: 'single', id: t.id, item: t });
    }
  }
  flushRun();
  return out;
}

function FilePill({
  filePath,
  rangeLabel,
  active,
  onPreviewFile,
  onOpenFileInEditor,
}: {
  filePath: string;
  rangeLabel?: string | null;
  active?: boolean;
  onPreviewFile?: (filePath: string, startLine?: number, endLine?: number) => void;
  onOpenFileInEditor?: (filePath: string) => void;
}) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && onOpenFileInEditor) {
      onOpenFileInEditor(filePath);
      return;
    }
    if (onPreviewFile) {
      const { startLine, endLine } = parseNumericRange(rangeLabel);
      onPreviewFile(filePath, startLine, endLine);
      return;
    }
    onOpenFileInEditor?.(filePath);
  };

  return (
    <button
      type="button"
      className="ag-file-pill mono pressable"
      data-active={active ? 'true' : 'false'}
      onClick={handleClick}
      title={`${filePath} (Click to preview, Ctrl+Click to open in editor)`}
      aria-label={`Preview ${filePath}`}
    >
      <FileCode2 size={11} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} aria-hidden="true" />
      <span className="ag-file-pill-name">{extractBasename(filePath)}</span>
      {rangeLabel && <span className="ag-file-pill-range">{rangeLabel}</span>}
    </button>
  );
}

function renderSingleAction(tool: ToolCallLog) {
  const isEdit =
    tool.toolName === 'patch_file' ||
    tool.toolName === 'patch_hashline' ||
    tool.toolName === 'create_file' ||
    tool.toolName === 'delete_file' ||
    tool.toolName === 'move_file';
  const isRead = tool.toolName === 'read_range' || tool.toolName === 'read_symbol';
  const isSkill = tool.toolName === 'read_skill' || tool.toolName === 'save_skill';
  const isWeb = tool.toolName === 'web_lookup';
  const isSearch =
    tool.toolName === 'repo_search' ||
    tool.toolName === 'fast_scout' ||
    tool.toolName === 'list_dir' ||
    tool.toolName === 'find_files';
  const isCmd = tool.toolName === 'run_command';
  const isVerify = tool.toolName === 'verify_gate';
  const isRunning = tool.status === 'running';

  const verb = isSkill
    ? tool.toolName === 'save_skill'
      ? isRunning
        ? 'Saving skill'
        : 'Saved skill'
      : isRunning
        ? 'Loading skill'
        : 'Loaded skill'
    : isEdit
    ? tool.toolName === 'create_file'
      ? isRunning
        ? 'Creating'
        : 'Created'
      : tool.toolName === 'delete_file'
        ? isRunning
          ? 'Deleting'
          : 'Deleted'
        : tool.toolName === 'move_file'
          ? isRunning
            ? 'Moving'
            : 'Moved'
          : isRunning
            ? 'Editing'
            : 'Edited'
    : isRead
      ? isRunning
        ? 'Analyzing'
        : 'Analyzed'
      : isWeb
        ? isRunning
          ? 'Looking up'
          : 'Looked up'
        : isSearch
          ? tool.toolName === 'fast_scout'
            ? isRunning
              ? 'Scanning'
              : 'Scanned'
            : tool.toolName === 'list_dir'
              ? isRunning
                ? 'Listing'
                : 'Listed'
              : tool.toolName === 'find_files'
                ? isRunning
                  ? 'Finding'
                  : 'Found'
                : isRunning
                  ? 'Searching'
                  : 'Searched'
          : isVerify
            ? isRunning
              ? 'Verifying'
              : 'Verified'
            : isCmd
              ? isRunning
                ? 'Running'
                : 'Ran'
              : tool.toolName === 'update_plan_step'
                ? 'Updated plan'
                : tool.toolName;

  const targetFile =
    tool.filePath ||
    (isEdit || isRead ? tool.summary.split(/\s|::/)[0] : undefined);
  const rangeLabel = isRead ? extractLineRange(tool.summary) : null;

  return {
    isEdit,
    isRead,
    isSkill,
    isWeb,
    isSearch,
    isCmd,
    isVerify,
    isRunning,
    verb,
    targetFile,
    rangeLabel,
  };
}

export function ActivityTimeline({
  toolCalls,
  isStreaming = false,
  onPreviewFile,
  onOpenFileInEditor,
  onRetryToolError,
  onLayoutChange,
}: ActivityTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (onLayoutChange) {
      requestAnimationFrame(() => onLayoutChange());
    }
  };

  const groups = groupTools(toolCalls, isStreaming);

  return (
    <div className="codex-timeline" aria-label="Agent activity timeline">
      {groups.map((grp, idx) => {
        if (grp.kind === 'explore-group') {
          const isRunning = grp.items.some((i) => i.status === 'running');
          const expanded = expandedIds.has(grp.id);
          const uniqueFiles = [...new Set(grp.items.map((i) => i.filePath).filter(Boolean))] as string[];
          const visiblePills = uniqueFiles.slice(0, 3);
          const extraCount = Math.max(0, uniqueFiles.length - visiblePills.length);

          return (
            <div
              key={grp.id}
              className="stagger-item"
              style={{ '--stagger-index': Math.min(idx, 6) } as React.CSSProperties}
            >
              <div
                role="button"
                tabIndex={0}
                className="pressable hover-surface ag-step-row"
                onClick={() => toggle(grp.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle(grp.id);
                  }
                }}
                aria-expanded={expanded}
              >
                {isRunning ? (
                  <Loader2
                    size={13}
                    className="codex-spinner"
                    style={{ color: 'var(--accent-blue)', flexShrink: 0 }}
                    aria-hidden="true"
                  />
                ) : (
                  <Eye size={13} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} aria-hidden="true" />
                )}
                <span className={isRunning ? 'shimmer-text' : undefined} style={{ fontWeight: 500, flexShrink: 0 }}>
                  {isRunning
                    ? 'Analyzing files...'
                    : uniqueFiles.length > 0
                      ? `Analyzed ${uniqueFiles.length} ${uniqueFiles.length === 1 ? 'file' : 'files'}`
                      : `Explored ${grp.items.length} ${grp.items.length === 1 ? 'target' : 'targets'}`}
                </span>

                {visiblePills.length > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
                    {visiblePills.map((fp) => (
                      <FilePill
                        key={fp}
                        filePath={fp}
                        onPreviewFile={onPreviewFile}
                        onOpenFileInEditor={onOpenFileInEditor}
                      />
                    ))}
                    {extraCount > 0 && (
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        +{extraCount}
                      </span>
                    )}
                  </span>
                )}

                <ChevronRight
                  size={12}
                  className="chevron-rotator"
                  data-open={expanded}
                  style={{ marginLeft: 'auto', color: 'var(--text-muted)', flexShrink: 0 }}
                  aria-hidden="true"
                />
              </div>

              {expanded && (
                <div className="ag-step-details">
                  {grp.items.map((sub) => {
                    const meta = renderSingleAction(sub);
                    return (
                      <div
                        key={sub.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 11.5,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <span style={{ color: 'var(--text-muted)', minWidth: 72, fontWeight: 500 }}>
                          {meta.verb}
                        </span>
                        {meta.targetFile ? (
                          <FilePill
                            filePath={meta.targetFile}
                            rangeLabel={meta.rangeLabel}
                            onPreviewFile={onPreviewFile}
                            onOpenFileInEditor={onOpenFileInEditor}
                          />
                        ) : (
                          <span
                            className="mono"
                            style={{
                              flex: 1,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {sub.summary}
                          </span>
                        )}
                        {sub.durationMs !== undefined && (
                          <span className="mono tabular-nums" style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
                            {sub.durationMs}ms
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }

        const tool = grp.item;
        const expanded = expandedIds.has(tool.id);
        const meta = renderSingleAction(tool);
        const isFailure = tool.status === 'error' || tool.status === 'denied';
        const showLiveTail =
          meta.isRunning && (meta.isCmd || meta.isVerify) && Boolean(tool.liveOutput);

        return (
          <div
            key={tool.id}
            className="stagger-item"
            style={{ '--stagger-index': Math.min(idx, 6) } as React.CSSProperties}
          >
            <div
              role="button"
              tabIndex={0}
              className="pressable hover-surface ag-step-row"
              data-running={meta.isRunning ? 'true' : 'false'}
              onClick={() => toggle(tool.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(tool.id);
                }
              }}
              aria-expanded={expanded}
            >
              {meta.isRunning ? (
                <span className="status-orb" aria-hidden="true" />
              ) : isFailure ? (
                <XCircle size={13} style={{ color: 'var(--accent-red)', flexShrink: 0 }} aria-hidden="true" />
              ) : meta.isSkill ? (
                <Sparkles size={13} style={{ color: 'var(--accent-brand)', flexShrink: 0 }} aria-hidden="true" />
              ) : meta.isEdit ? (
                <FileEdit size={13} style={{ color: 'var(--accent-green)', flexShrink: 0 }} aria-hidden="true" />
              ) : meta.isRead ? (
                <Eye size={13} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} aria-hidden="true" />
              ) : meta.isWeb ? (
                <Globe size={13} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} aria-hidden="true" />
              ) : meta.isSearch ? (
                <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
              ) : meta.isVerify ? (
                <ShieldCheck size={13} style={{ color: 'var(--accent-green)', flexShrink: 0 }} aria-hidden="true" />
              ) : meta.isCmd ? (
                <Terminal size={13} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} aria-hidden="true" />
              ) : tool.status === 'ok' ? (
                <CheckCircle2 size={13} style={{ color: 'var(--accent-green)', flexShrink: 0 }} aria-hidden="true" />
              ) : (
                <Wrench size={13} style={{ flexShrink: 0 }} aria-hidden="true" />
              )}

              <span
                className={meta.isRunning ? 'shimmer-text' : undefined}
                style={{ fontWeight: 500, color: 'var(--text-secondary)', flexShrink: 0 }}
              >
                {meta.verb}
              </span>

              {meta.targetFile ? (
                <FilePill
                  filePath={meta.targetFile}
                  rangeLabel={meta.rangeLabel}
                  active={meta.isRunning}
                  onPreviewFile={onPreviewFile}
                  onOpenFileInEditor={onOpenFileInEditor}
                />
              ) : (
                <span
                  className={meta.isCmd ? 'mono' : undefined}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12,
                    color: 'var(--text-primary)',
                  }}
                >
                  {tool.summary}
                </span>
              )}

              {(tool.linesAdded !== undefined || tool.linesRemoved !== undefined) && (
                <span className="mono tabular-nums" style={{ fontSize: 11.5, flexShrink: 0, marginLeft: 'auto' }}>
                  <span style={{ color: 'var(--accent-green)' }}>+{tool.linesAdded ?? 0}</span>{' '}
                  <span style={{ color: 'var(--accent-red)' }}>-{tool.linesRemoved ?? 0}</span>
                </span>
              )}

              {tool.durationMs !== undefined && (
                <span
                  className="mono tabular-nums"
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    flexShrink: 0,
                    marginLeft:
                      tool.linesAdded === undefined && tool.linesRemoved === undefined ? 'auto' : 0,
                  }}
                >
                  {tool.durationMs}ms
                </span>
              )}
            </div>

            {showLiveTail && (
              <pre className="mono ag-step-details ag-live-output" aria-live="polite">
                {tool.liveOutput}
              </pre>
            )}

            {isFailure && (
              <div className="ag-step-details ag-error-diagnostic" role="status">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: 'var(--accent-red)', fontWeight: 500, fontSize: 11.5 }}>
                    {tool.status === 'denied' ? 'Action blocked' : 'Tool failed'}
                  </span>
                  {onRetryToolError && (
                    <button
                      type="button"
                      className="pressable hover-surface ag-retry-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRetryToolError(tool);
                      }}
                    >
                      <RotateCw size={11} aria-hidden="true" />
                      <span>Retry / Fix</span>
                    </button>
                  )}
                </div>
                <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto' }}>
                  {tool.liveOutput || tool.resultPreview || tool.argsPreview}
                </pre>
              </div>
            )}

            {expanded && !showLiveTail && !isFailure && (
              <div className="mono ag-step-details" style={{ maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                {tool.liveOutput || tool.resultPreview || tool.argsPreview}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
