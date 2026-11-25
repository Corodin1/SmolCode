import { ArchiveRestore, ArrowLeft, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ProjectRecord, ThreadRecord } from '../../shared/types';
import { formatRelativeTime } from '../../utils/audio-notify';

interface ArchivedThreadsViewProps {
  threads: ThreadRecord[];
  projects: ProjectRecord[];
  onBack: () => void;
  onUnarchive: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}

export function ArchivedThreadsView({
  threads,
  projects,
  onBack,
  onUnarchive,
  onDelete,
}: ArchivedThreadsViewProps) {
  const [query, setQuery] = useState('');
  const archived = threads.filter(
    (t) => t.archived && t.title.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={onBack}
            style={{
              height: 30,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
            }}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <span>Back</span>
          </button>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Archived Threads</h1>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            className="codex-input-shell"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 34,
              padding: '0 12px',
              borderRadius: 9,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
            }}
          >
            <Search size={13} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search archived threads..."
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                outline: 'none',
                fontSize: 13,
              }}
            />
          </div>

          {archived.length === 0 ? (
            <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No archived threads.
            </div>
          ) : (
            archived.map((th) => {
              const proj = projects.find((p) => p.id === th.projectId);
              return (
                <div
                  key={th.id}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 10,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{th.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {proj?.name ?? 'Workspace'} · {formatRelativeTime(th.updatedAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pressable hover-surface"
                    onClick={() => onUnarchive(th.id)}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 7,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-surface)',
                      fontSize: 12,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <ArchiveRestore size={12} aria-hidden="true" />
                    <span>Restore</span>
                  </button>
                  <button
                    type="button"
                    className="pressable hover-surface"
                    onClick={() => onDelete(th.id)}
                    aria-label={`Delete ${th.title}`}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      border: '1px solid var(--border-subtle)',
                      background: 'transparent',
                      color: 'var(--accent-red)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
