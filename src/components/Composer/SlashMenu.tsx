import { Command, Sparkles } from 'lucide-react';
import type { SkillEntry } from '../../shared/types';
import { FrostedSurface } from '../Common/FrostedSurface';

export interface SlashCommandDef {
  id: string;
  name: string;
  description: string;
  badge?: string;
}

export const BUILTIN_SLASH_COMMANDS: SlashCommandDef[] = [
  { id: 'plan', name: 'plan', description: 'Toggle Plan mode (read-only design & plan card)', badge: 'Shift+Tab' },
  { id: 'compact', name: 'compact', description: 'Summarize earlier turns to free active context window' },
  { id: 'new', name: 'new', description: 'Start a fresh thread in this workspace', badge: 'Ctrl+N' },
  { id: 'status', name: 'status', description: 'Inspect active context, KV cache, and GPU VRAM' },
  { id: 'skills', name: 'skills', description: 'Browse or create workspace skills' },
  { id: 'mcp', name: 'mcp', description: 'Configure MCP servers & tools' },
  { id: 'init', name: 'init', description: 'Generate or update project AGENTS.md instructions' },
];

export type SlashItem =
  | { kind: 'command'; cmd: SlashCommandDef }
  | { kind: 'skill'; skill: SkillEntry };

interface SlashMenuProps {
  items: SlashItem[];
  selectedIdx: number;
  onSelect: (item: SlashItem) => void;
}

export function SlashMenu({ items, selectedIdx, onSelect }: SlashMenuProps) {
  if (items.length === 0) return null;
  return (
    <FrostedSurface
      variant="popover"
      cornerRadius={11}
      className="codex-popover"
      role="listbox"
      aria-label="Slash commands and skills"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 'var(--z-popover)',
        '--transform-origin': 'bottom left',
      } as React.CSSProperties}
    >
      <div style={{ maxHeight: 260, overflowY: 'auto', padding: 6 }}>
      {items.map((item, idx) => {
        const key = item.kind === 'command' ? `cmd-${item.cmd.id}` : `sk-${item.skill.id}`;
        return (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={idx === selectedIdx}
            className="pressable hover-surface"
            onClick={() => onSelect(item)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '6px 9px',
              border: 'none',
              borderRadius: 8,
              background: idx === selectedIdx ? 'var(--bg-surface-active)' : 'transparent',
              textAlign: 'left',
            }}
          >
            {item.kind === 'command' ? (
              <Command size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
            ) : (
              <Sparkles size={13} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} aria-hidden="true" />
            )}
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
              /{item.kind === 'command' ? item.cmd.name : item.skill.name}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: 12,
                color: 'var(--text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.kind === 'command' ? item.cmd.description : item.skill.description}
            </span>
            {item.kind === 'command' && item.cmd.badge && (
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                {item.cmd.badge}
              </span>
            )}
            {item.kind === 'skill' && (
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                {item.skill.scope}
              </span>
            )}
          </button>
        );
      })}
      </div>
    </FrostedSurface>
  );
}
