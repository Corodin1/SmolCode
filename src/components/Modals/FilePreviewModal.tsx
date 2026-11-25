import { Check, Copy, ExternalLink, FileCode2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PreferredEditor } from '../../shared/types';

export interface FilePreviewTarget {
  projectId: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

interface FilePreviewModalProps {
  target: FilePreviewTarget;
  preferredEditor: PreferredEditor;
  onOpenInEditor: (absOrRelPath: string) => void;
  onClose: () => void;
}

interface SliceState {
  loadedKey: string;
  error?: string;
  absPath?: string;
  relPath?: string;
  totalLines?: number;
  lines: Array<{ line: number; text: string }>;
}

export function FilePreviewModal({
  target,
  preferredEditor,
  onOpenInEditor,
  onClose,
}: FilePreviewModalProps) {
  const requestKey = `${target.projectId}:${target.filePath}:${target.startLine ?? 1}:${target.endLine ?? 0}`;
  const [state, setState] = useState<SliceState>({ loadedKey: '', lines: [] });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const previewAvailable = Boolean(window.smolcode?.readFileSlice);

  useEffect(() => {
    if (!window.smolcode?.readFileSlice) return;
    let cancelled = false;
    const from = Math.max(1, (target.startLine ?? 1) - 10);
    const to = Math.max(from + 80, (target.endLine ?? from + 60) + 15);
    void window.smolcode
      .readFileSlice(target.projectId, target.filePath, from, to)
      .then((res) => {
        if (cancelled) return;
        setState({
          loadedKey: requestKey,
          absPath: res.absPath,
          relPath: res.relPath,
          totalLines: res.totalLines,
          lines: res.lines,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          loadedKey: requestKey,
          error: err instanceof Error ? err.message : String(err),
          lines: [],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, target.projectId, target.filePath, target.startLine, target.endLine]);

  const isLoading = previewAvailable && state.loadedKey !== requestKey;
  const errorMessage = !previewAvailable
    ? 'Preview unavailable outside Electron.'
    : state.loadedKey === requestKey
      ? state.error
      : undefined;

  const highlightStart = target.startLine ?? -1;
  const highlightEnd = target.endLine ?? target.startLine ?? -1;

  const copyPath = () => {
    void navigator.clipboard?.writeText(state.relPath ?? target.filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div
      className="codex-modal-backdrop glass-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${target.filePath}`}
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 'var(--z-modal)',
      }}
    >
      <div
        className="codex-modal-card glass-popover"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 780,
          maxWidth: '94vw',
          maxHeight: '84vh',
          borderRadius: 14,
          border: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '11px 14px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
          }}
        >
          <FileCode2 size={15} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} aria-hidden="true" />
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state.relPath ?? target.filePath}
          </span>
          {state.totalLines !== undefined && (
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
              ({state.totalLines} lines)
            </span>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <button
              type="button"
              className="pressable hover-surface"
              onClick={copyPath}
              style={{
                height: 26,
                padding: '0 9px',
                borderRadius: 7,
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-elevated)',
                fontSize: 11.5,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
              <span>{copied ? 'Copied' : 'Copy path'}</span>
            </button>

            <button
              type="button"
              className="pressable codex-primary-btn"
              onClick={() => onOpenInEditor(state.absPath ?? target.filePath)}
              title={`Open in ${preferredEditor}`}
              style={{
                height: 26,
                padding: '0 10px',
                borderRadius: 7,
                border: 'none',
                background: 'var(--accent-primary)',
                color: 'var(--accent-primary-fg)',
                fontSize: 11.5,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <ExternalLink size={11} aria-hidden="true" />
              <span>Open in Editor</span>
            </button>

            <button
              type="button"
              className="pressable hover-surface"
              onClick={onClose}
              aria-label="Close file preview"
              style={{
                width: 26,
                height: 26,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0', background: 'var(--bg-canvas)' }}>
          {isLoading ? (
            <div style={{ padding: 20, fontSize: 12.5, color: 'var(--text-muted)' }}>
              Loading file slice...
            </div>
          ) : errorMessage ? (
            <div style={{ padding: 20, fontSize: 12.5, color: 'var(--accent-red)' }}>
              {errorMessage}
            </div>
          ) : (
            <div className="mono" style={{ fontSize: 12, lineHeight: 1.55 }}>
              {state.lines.map((row) => {
                const isHighlighted =
                  highlightStart > 0 && row.line >= highlightStart && row.line <= highlightEnd;
                return (
                  <div
                    key={row.line}
                    style={{
                      display: 'flex',
                      padding: '0 14px',
                      background: isHighlighted ? 'var(--accent-brand-soft)' : 'transparent',
                    }}
                  >
                    <span
                      className="tabular-nums"
                      style={{
                        width: 44,
                        flexShrink: 0,
                        textAlign: 'right',
                        paddingRight: 12,
                        color: isHighlighted ? 'var(--accent-brand)' : 'var(--text-muted)',
                        userSelect: 'none',
                      }}
                    >
                      {row.line}
                    </span>
                    <span style={{ whiteSpace: 'pre', overflowX: 'visible' }}>{row.text || ' '}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
