import {
  ChevronRight,
  FileDiff,
  FileMinus2,
  FilePlus2,
  RotateCcw,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UndoDiffFile, UndoPreviewResult } from '../../shared/types';
import { FrostedSurface } from '../Common/FrostedSurface';

interface UndoConfirmModalProps {
  threadId: string;
  targetTurnId: string;
  onConfirm: (preview: UndoPreviewResult) => Promise<void> | void;
  onClose: () => void;
}

interface PreviewLoadState {
  loadedKey: string;
  preview?: UndoPreviewResult;
  error?: string;
}

function FileStatusBadge({ status }: { status: UndoDiffFile['status'] }) {
  if (status === 'added') {
    return (
      <span className="ag-undo-badge ag-undo-badge-delete">
        <FileMinus2 size={11} aria-hidden="true" />
        Added · will delete
      </span>
    );
  }
  if (status === 'deleted') {
    return (
      <span className="ag-undo-badge ag-undo-badge-restore">
        <FilePlus2 size={11} aria-hidden="true" />
        Deleted · will restore
      </span>
    );
  }
  return (
    <span className="ag-undo-badge ag-undo-badge-modify">
      <FileDiff size={11} aria-hidden="true" />
      Modified · will revert
    </span>
  );
}

export function UndoConfirmModal({
  threadId,
  targetTurnId,
  onConfirm,
  onClose,
}: UndoConfirmModalProps) {
  const requestKey = `${threadId}:${targetTurnId}`;
  const [loadState, setLoadState] = useState<PreviewLoadState>({ loadedKey: '' });
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, submitting]);

  const previewApiAvailable = Boolean(window.smolcode?.previewUndoToTurn);

  useEffect(() => {
    if (!window.smolcode?.previewUndoToTurn) return;
    let cancelled = false;
    void window.smolcode
      .previewUndoToTurn(threadId, targetTurnId)
      .then((preview) => {
        if (cancelled) return;
        setLoadState({ loadedKey: requestKey, preview });
        if (preview.fileChanges.length > 0 && preview.fileChanges.length <= 3) {
          setExpandedPaths({ [preview.fileChanges[0].path]: true });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState({
          loadedKey: requestKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, threadId, targetTurnId]);

  const isLoading = previewApiAvailable && loadState.loadedKey !== requestKey;
  const errorMessage = !previewApiAvailable
    ? 'Undo preview is unavailable outside Electron.'
    : loadState.loadedKey === requestKey
      ? (confirmError ?? loadState.error)
      : undefined;
  const preview = loadState.loadedKey === requestKey ? loadState.preview : undefined;

  const allExpanded =
    Boolean(preview?.fileChanges.length) &&
    preview!.fileChanges.every((f) => Boolean(expandedPaths[f.path]));

  const toggleAllFiles = () => {
    if (!preview) return;
    if (allExpanded) {
      setExpandedPaths({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const file of preview.fileChanges) {
      next[file.path] = true;
    }
    setExpandedPaths(next);
  };

  const handleConfirm = async () => {
    if (!preview || submitting) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      await onConfirm(preview);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="codex-modal-backdrop glass-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <FrostedSurface
        variant="modal"
        cornerRadius={18}
        className="codex-modal-card ag-undo-modal"
        role="dialog"
        aria-modal={true}
        aria-label="Undo to this point?"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ag-undo-modal-header">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, minWidth: 0 }}>
            <div className="ag-undo-icon-badge" aria-hidden="true">
              <RotateCcw size={15} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h2
                id="undo-modal-title"
                style={{
                  margin: 0,
                  fontSize: 15,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: 'var(--text-primary)',
                }}
              >
                Undo to this point?
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Restore workspace files and conversation history back before this turn.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close undo preview"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="ag-undo-modal-body">
          {isLoading && (
            <div
              role="status"
              style={{
                padding: '22px 0',
                fontSize: 12.5,
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span className="status-orb" aria-hidden="true" />
              <span>Calculating checkpoint diff...</span>
            </div>
          )}

          {errorMessage && (
            <div
              role="alert"
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid color-mix(in srgb, var(--accent-red) 45%, transparent)',
                background: 'var(--accent-red-soft)',
                color: 'var(--accent-red)',
                fontSize: 12.5,
              }}
            >
              {errorMessage}
            </div>
          )}

          {preview && (
            <>
              <div className="ag-undo-summary-row">
                <span className="ag-undo-pill">
                  {preview.turnsToRemoveCount} turn{preview.turnsToRemoveCount === 1 ? '' : 's'} removed
                </span>
                <span className="ag-undo-pill">
                  {preview.fileChanges.length} file{preview.fileChanges.length === 1 ? '' : 's'} affected
                </span>
                {preview.restoredPrompt && (
                  <span className="ag-undo-pill">Prompt restored to composer</span>
                )}
              </div>

              {preview.restoredPrompt && (
                <div className="ag-undo-prompt-box">
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                    Restored composer prompt
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                      maxHeight: 96,
                      overflowY: 'auto',
                    }}
                  >
                    {preview.restoredPrompt}
                  </div>
                </div>
              )}

              {preview.fileChanges.length === 0 ? (
                <div className="ag-undo-empty-files">
                  {preview.hasSnapshot
                    ? 'No workspace files changed after this checkpoint. Only the conversation turns above will be removed.'
                    : 'No filesystem snapshot was recorded for this turn. Only conversation turns will be removed.'}
                </div>
              ) : (
                <>
                  {preview.fileChanges.length > 1 && (
                    <div className="ag-undo-files-toolbar">
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}>
                        Checkpoint File Diffs
                      </span>
                      <button
                        type="button"
                        className="pressable hover-surface"
                        onClick={toggleAllFiles}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          padding: '2px 7px',
                          borderRadius: 6,
                          fontSize: 11.5,
                          fontWeight: 500,
                          color: 'var(--accent-brand)',
                        }}
                      >
                        {allExpanded ? 'Collapse all' : 'Expand all'}
                      </button>
                    </div>
                  )}

                  <div className="ag-undo-file-list">
                    {preview.fileChanges.map((file) => {
                      const isOpen = Boolean(expandedPaths[file.path]);
                      return (
                        <div key={file.path} className="ag-undo-file-card">
                          <button
                            type="button"
                            className="ag-undo-file-toggle hover-surface"
                            onClick={() =>
                              setExpandedPaths((prev) => ({
                                ...prev,
                                [file.path]: !prev[file.path],
                              }))
                            }
                            aria-expanded={isOpen}
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                              <ChevronRight
                                size={13}
                                className="chevron-rotator"
                                data-open={isOpen}
                                style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                                aria-hidden="true"
                              />
                              <span
                                className="mono"
                                style={{
                                  fontSize: 12,
                                  fontWeight: 500,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {file.path}
                              </span>
                            </span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                              <FileStatusBadge status={file.status} />
                              <span
                                className="mono tabular-nums"
                                style={{
                                  fontSize: 11,
                                  color: 'var(--text-muted)',
                                }}
                              >
                                <span style={{ color: 'var(--accent-green)' }}>+{file.additions}</span>{' '}
                                <span style={{ color: 'var(--accent-red)' }}>-{file.deletions}</span>
                              </span>
                            </span>
                          </button>

                          {isOpen && (
                            <div className="ag-undo-diff-scroll">
                              {file.lines.map((line, idx) => (
                                <div
                                  key={`${file.path}-${idx}`}
                                  className={`ag-undo-diff-line ag-undo-diff-${line.kind}`}
                                >
                                  <span className="ag-undo-diff-ln">
                                    {line.kind === 'remove'
                                      ? line.oldLine ?? ''
                                      : line.kind === 'add'
                                        ? line.newLine ?? ''
                                        : line.oldLine ?? ''}
                                  </span>
                                  <span className="ag-undo-diff-marker">
                                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                                  </span>
                                  <span className="ag-undo-diff-text">{line.text || ' '}</span>
                                </div>
                              ))}
                              {file.truncated && (
                                <div
                                  style={{
                                    padding: '6px 12px',
                                    fontSize: 11,
                                    color: 'var(--text-muted)',
                                  }}
                                >
                                  Diff truncated for preview performance.
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="ag-undo-modal-footer">
          <button
            type="button"
            className="pressable hover-surface"
            onClick={onClose}
            disabled={submitting}
            style={{
              height: 32,
              padding: '0 14px',
              borderRadius: 9,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
              fontSize: 12.5,
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pressable ag-undo-confirm-btn"
            onClick={() => void handleConfirm()}
            disabled={!preview || submitting}
            aria-busy={submitting}
          >
            <RotateCcw size={13} aria-hidden="true" />
            <span>{submitting ? 'Restoring...' : 'Undo to this point'}</span>
          </button>
        </div>
      </FrostedSurface>
    </div>
  );
}
