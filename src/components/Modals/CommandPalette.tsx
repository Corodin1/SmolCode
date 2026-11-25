import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SkillEntry, ThreadRecord } from '../../shared/types';
import { FrostedSurface } from '../Common/FrostedSurface';

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  threads: ThreadRecord[];
  skills?: SkillEntry[];
  commands: PaletteCommand[];
  onSelectThread: (threadId: string) => void;
  onSelectSkill?: (skill: SkillEntry) => void;
  onClose: () => void;
}

export function CommandPalette({
  threads,
  skills = [],
  commands,
  onSelectThread,
  onSelectSkill,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  const items: PaletteCommand[] = [
    ...commands,
    ...threads
      .filter((t) => !t.archived)
      .map((t) => ({
        id: `thread:${t.id}`,
        label: t.title,
        group: 'Threads',
        run: () => onSelectThread(t.id),
      })),
    ...(onSelectSkill
      ? skills.map((sk) => ({
          id: `skill:${sk.id}`,
          label: `/${sk.name}${sk.description ? ` — ${sk.description}` : ''}`,
          group: 'Skills',
          run: () => onSelectSkill(sk),
        }))
      : []),
  ].filter((item) =>
    item.label.toLowerCase().includes(query.trim().toLowerCase()) ||
    item.group.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => (items.length ? (i + 1) % items.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) =>
          items.length ? (i - 1 + items.length) % items.length : 0,
        );
      } else if (e.key === 'Enter' && items[selectedIdx]) {
        e.preventDefault();
        items[selectedIdx].run();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selectedIdx, onClose]);

  return (
    <div
      className="codex-instant-palette glass-backdrop"
      role="dialog"
      aria-label="Command Palette"
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 88,
        zIndex: 'var(--z-modal)',
      }}
    >
      <FrostedSurface
        variant="palette"
        cornerRadius={16}
        className="codex-instant-palette"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '92vw',
        }}
      >
        <div style={{ borderRadius: 16, overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '11px 14px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <Search size={15} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            placeholder="Jump to thread, skill, or command..."
            aria-label="Search commands and threads"
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontSize: 13.5,
            }}
          />
        </div>

        <div style={{ maxHeight: 340, overflowY: 'auto', padding: 6 }}>
          {items.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)' }}>
              No matching commands or threads
            </div>
          ) : (
            items.slice(0, 24).map((item, idx) => (
              <button
                key={item.id}
                type="button"
                className="hover-surface"
                onClick={() => {
                  item.run();
                  onClose();
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '7px 10px',
                  border: 'none',
                  borderRadius: 8,
                  background: idx === selectedIdx ? 'var(--bg-surface-active)' : 'transparent',
                  fontSize: 12.5,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {item.label}
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {item.shortcut ?? item.group}
                </span>
              </button>
            ))
          )}
        </div>
        </div>
      </FrostedSurface>
    </div>
  );
}
