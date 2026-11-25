import {
  ChevronDown,
  Code2,
  ExternalLink,
  FolderOpen,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeft,
  Plus,
  SquareTerminal,
  Sun,
  Terminal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  CenterView,
  PreferredEditor,
  ProjectRecord,
  ThreadRecord,
} from '../shared/types';
import { FrostedSurface } from './Common/FrostedSurface';
import { Tooltip } from './Common/Tooltip';

interface TitlebarProps {
  project: ProjectRecord | null;
  thread: ThreadRecord | null;
  centerView: CenterView;
  theme: 'light' | 'dark';
  sidebarOpen: boolean;
  terminalOpen: boolean;
  miniWindow: boolean;
  preferredEditor: PreferredEditor;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onToggleTheme: () => void;
  onToggleMiniWindow: () => void;
  onNewThread: () => void;
  onRenameThread: (title: string) => void;
  onOpenInEditor: (editor: PreferredEditor) => void;
}

const EDITORS: Array<{ id: PreferredEditor; label: string; icon: typeof Code2 }> = [
  { id: 'vscode', label: 'VS Code', icon: Code2 },
  { id: 'cursor', label: 'Cursor', icon: Code2 },
  { id: 'windsurf', label: 'Windsurf', icon: Code2 },
  { id: 'explorer', label: 'File Explorer', icon: FolderOpen },
  { id: 'terminal', label: 'External Terminal', icon: Terminal },
];

export function Titlebar({
  project,
  thread,
  centerView,
  theme,
  sidebarOpen,
  terminalOpen,
  miniWindow,
  preferredEditor,
  onToggleSidebar,
  onToggleTerminal,
  onToggleTheme,
  onToggleMiniWindow,
  onNewThread,
  onRenameThread,
  onOpenInEditor,
}: TitlebarProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const openMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(e.target as Node)) {
        setOpenMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [openMenuOpen]);

  const startRename = () => {
    if (!thread) return;
    setTitleDraft(thread.title);
    setEditingTitle(true);
  };

  const commitRename = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && thread && trimmed !== thread.title) {
      onRenameThread(trimmed);
    }
    setEditingTitle(false);
  };

  const viewLabel =
    centerView === 'skills'
      ? 'Skills'
      : centerView === 'automations'
        ? 'Automations'
        : centerView === 'settings'
          ? 'Settings'
          : centerView === 'archived'
            ? 'Archived Threads'
            : null;

  return (
    <header className="titlebar" role="banner">
      <div className="titlebar-group" style={{ flex: 1, minWidth: 0 }}>
        <Tooltip label="Toggle sidebar" shortcut="Ctrl+B">
          <button
            type="button"
            className="titlebar-icon-btn pressable hover-surface"
            data-active={sidebarOpen}
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar (Ctrl+B)"
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
        </Tooltip>

        <Tooltip label="New thread" shortcut="Ctrl+N">
          <button
            type="button"
            className="titlebar-icon-btn pressable hover-surface"
            onClick={onNewThread}
            aria-label="New thread (Ctrl+N)"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </Tooltip>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginLeft: 4,
            minWidth: 0,
            flex: 1,
          }}
        >
          {viewLabel ? (
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
              {viewLabel}
            </span>
          ) : (
            <>
              {thread && editingTitle ? (
                <input
                  autoFocus
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingTitle(false);
                  }}
                  aria-label="Rename active thread"
                  style={{
                    height: 24,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: '1px solid var(--border-strong)',
                    background: 'var(--bg-canvas)',
                    fontSize: 13,
                    fontWeight: 500,
                    maxWidth: 280,
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={startRename}
                  disabled={!thread}
                  title={thread ? 'Click to rename thread' : undefined}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    padding: '2px 5px',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: thread ? 'text' : 'default',
                    maxWidth: 260,
                  }}
                >
                  {thread ? thread.title : project ? project.name : 'SmolCode'}
                </button>
              )}

              {project && (
                <span
                  className="codex-hide-mini"
                  style={{
                    color: 'var(--text-muted)',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {project.name}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="titlebar-group" style={{ position: 'relative', flexShrink: 0 }}>
        {project && (
          <div ref={openMenuRef} className="codex-hide-mini" style={{ position: 'relative', display: 'flex' }}>
            <button
              type="button"
              className="codex-pill pressable hover-surface"
              style={{
                height: 26,
                padding: '0 8px',
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                borderRight: 'none',
                fontSize: 11.5,
              }}
              onClick={() => onOpenInEditor(preferredEditor)}
              title="Open active workspace in editor"
            >
              <ExternalLink size={11.5} aria-hidden="true" />
              <span>Open</span>
            </button>
            <button
              type="button"
              className="codex-pill pressable hover-surface"
              style={{
                height: 26,
                padding: '0 5px',
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
              }}
              onClick={() => setOpenMenuOpen((v) => !v)}
              aria-expanded={openMenuOpen}
              aria-label="Choose external editor"
            >
              <ChevronDown size={11} aria-hidden="true" />
            </button>

            {openMenuOpen && (
              <FrostedSurface
                variant="popover"
                cornerRadius={12}
                className="codex-popover"
                role="menu"
                aria-label="Open workspace in"
                style={{
                  position: 'absolute',
                  top: 32,
                  right: 0,
                  width: 190,
                  padding: 5,
                  zIndex: 'var(--z-popover)',
                  '--transform-origin': 'top right',
                } as React.CSSProperties}
              >
                {EDITORS.map((ed) => {
                  const Icon = ed.icon;
                  return (
                    <button
                      key={ed.id}
                      type="button"
                      role="menuitem"
                      className="pressable hover-surface"
                      onClick={() => {
                        onOpenInEditor(ed.id);
                        setOpenMenuOpen(false);
                      }}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        border: 'none',
                        borderRadius: 7,
                        background: 'transparent',
                        fontSize: 12.5,
                        textAlign: 'left',
                      }}
                    >
                      <Icon size={13} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                      <span>{ed.label}</span>
                    </button>
                  );
                })}
              </FrostedSurface>
            )}
          </div>
        )}

        <Tooltip
          label={miniWindow ? 'Expand window' : 'Pop-out mini mode'}
          shortcut="Ctrl+Shift+M"
        >
          <button
            type="button"
            className="titlebar-icon-btn pressable hover-surface"
            data-active={miniWindow}
            onClick={onToggleMiniWindow}
            aria-label={miniWindow ? 'Expand to full window (Ctrl+Shift+M)' : 'Compact mini window (Ctrl+Shift+M)'}
          >
            {miniWindow ? <Maximize2 size={14} aria-hidden="true" /> : <Minimize2 size={14} aria-hidden="true" />}
          </button>
        </Tooltip>

        <Tooltip label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <button
            type="button"
            className="titlebar-icon-btn pressable hover-surface codex-hide-mini"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? (
              <Sun size={15} aria-hidden="true" />
            ) : (
              <Moon size={15} aria-hidden="true" />
            )}
          </button>
        </Tooltip>

        <Tooltip label="Toggle terminal" shortcut="Ctrl+J">
          <button
            type="button"
            className="titlebar-icon-btn pressable hover-surface"
            data-active={terminalOpen}
            onClick={onToggleTerminal}
            aria-label="Toggle terminal (Ctrl+J)"
          >
            <SquareTerminal size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
