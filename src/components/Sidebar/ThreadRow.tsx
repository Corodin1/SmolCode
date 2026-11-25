import { Archive, Pencil, Pin, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ThreadRecord } from '../../shared/types';
import { formatRelativeTime } from '../../utils/audio-notify';

interface ThreadRowProps {
  thread: ThreadRecord;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

export function ThreadRow({
  thread,
  active,
  onSelect,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
}: ThreadRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);

  const isBusy =
    thread.status === 'scouting' ||
    thread.status === 'thinking' ||
    thread.status === 'verifying';

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== thread.title) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      className="hover-reveal-parent codex-thread-row"
      data-active={active}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderRadius: 8,
        background: active ? 'var(--bg-surface-active)' : 'transparent',
        border: active
          ? '1px solid color-mix(in srgb, var(--accent-brand) 36%, var(--border-subtle))'
          : '1px solid transparent',
        minWidth: 0,
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {isBusy ? (
          <span
            className="status-orb"
            style={{ width: 8, height: 8 }}
            aria-label="Agent working"
          />
        ) : thread.status === 'awaiting_approval' || thread.status === 'awaiting_input' ? (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--accent-amber)',
            }}
            aria-label="Needs input"
          />
        ) : thread.status === 'queued' ? (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              border: '1.5px solid var(--text-muted)',
            }}
            aria-label="Queued"
          />
        ) : thread.unread ? (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--accent-blue)',
            }}
            aria-label="Unread completion"
          />
        ) : (
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--border-strong)',
            }}
            aria-hidden="true"
          />
        )}
      </span>

      {editing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Rename thread"
          style={{
            flex: 1,
            minWidth: 0,
            height: 22,
            padding: '0 5px',
            borderRadius: 5,
            border: '1px solid var(--border-strong)',
            background: 'var(--bg-canvas)',
            fontSize: 12.5,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => {
            setDraft(thread.title);
            setEditing(true);
          }}
          className="pressable"
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12.5,
              fontWeight: active ? 500 : 400,
            }}
            title={thread.title}
          >
            {thread.title}
          </span>
        </button>
      )}

      {!editing && (
        <span
          className="mono tabular-nums thread-row-time"
          style={{
            fontSize: 10.5,
            color: 'var(--text-muted)',
          }}
        >
          {formatRelativeTime(thread.updatedAt)}
        </span>
      )}

      <div className="thread-row-actions">
        <button
          type="button"
          className="pressable hover-surface"
          onClick={() => {
            setDraft(thread.title);
            setEditing(true);
          }}
          aria-label={`Rename ${thread.title}`}
          title="Rename"
          style={{
            width: 22,
            height: 22,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
          }}
        >
          <Pencil size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pressable hover-surface"
          onClick={onTogglePin}
          aria-label={thread.pinned ? 'Unpin thread' : 'Pin thread'}
          title={thread.pinned ? 'Unpin' : 'Pin'}
          style={{
            width: 22,
            height: 22,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: thread.pinned ? 'var(--accent-blue)' : 'var(--text-muted)',
          }}
        >
          <Pin size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pressable hover-surface"
          onClick={onArchive}
          aria-label={`Archive ${thread.title}`}
          title="Archive"
          style={{
            width: 22,
            height: 22,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
          }}
        >
          <Archive size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pressable hover-surface"
          onClick={onDelete}
          aria-label={`Delete thread ${thread.title}`}
          title="Delete"
          style={{
            width: 22,
            height: 22,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
          }}
        >
          <Trash2 size={11} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
