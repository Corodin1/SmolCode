import {
  Archive,
  ChevronRight,
  Clock,
  FolderPlus,
  HelpCircle,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CenterView, ProjectRecord, ThreadRecord } from '../../shared/types';
import { ThreadRow } from './ThreadRow';

interface SidebarProps {
  width: number;
  centerView: CenterView;
  projects: ProjectRecord[];
  threads: ThreadRecord[];
  activeThreadId: string | null;
  skillsCount: number;
  automationsCount: number;
  onNewThread: (projectId?: string) => void;
  onAddProject: () => void;
  onRemoveProject: (projectId: string) => void;
  onOpenProjectEnv: (projectId: string) => void;
  onToggleProject: (projectId: string, collapsed: boolean) => void;
  onSelectThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onTogglePin: (thread: ThreadRecord) => void;
  onArchiveThread: (threadId: string, archived: boolean) => void;
  onDeleteThread: (threadId: string) => void;
  onNavigateView: (view: CenterView) => void;
  onOpenShortcuts: () => void;
}

export function Sidebar({
  width,
  centerView,
  projects,
  threads,
  activeThreadId,
  skillsCount,
  automationsCount,
  onNewThread,
  onAddProject,
  onRemoveProject,
  onOpenProjectEnv,
  onToggleProject,
  onSelectThread,
  onRenameThread,
  onTogglePin,
  onArchiveThread,
  onDeleteThread,
  onNavigateView,
  onOpenShortcuts,
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'unread'>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'created'>('updated');
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);

  const activeThreads = useMemo(() => threads.filter((t) => !t.archived), [threads]);
  const archivedCount = threads.length - activeThreads.length;

  const filteredThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeThreads
      .filter((t) => {
        if (filterMode === 'unread' && !t.unread) return false;
        if (q && !t.title.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) =>
        sortBy === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt,
      );
  }, [activeThreads, filterMode, searchQuery, sortBy]);

  const pinnedThreads = useMemo(
    () => filteredThreads.filter((t) => t.pinned),
    [filteredThreads],
  );

  return (
    <aside
      className="left-sidebar"
      style={{ width }}
      aria-label="Workspace and thread navigation"
    >
      {/* Primary Codex Navigation */}
      <div style={{ padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          type="button"
          className="pressable hover-surface"
          onClick={() => onNewThread(projects[0]?.id)}
          style={{
            width: '100%',
            height: 33,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 10px',
            marginBottom: 4,
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <SquarePen size={14} aria-hidden="true" />
          <span style={{ flex: 1, textAlign: 'left' }}>New thread</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Ctrl+N
          </span>
        </button>

        <button
          type="button"
          className="sidebar-nav-btn pressable hover-surface"
          data-active={centerView === 'automations'}
          onClick={() => onNavigateView('automations')}
        >
          <Clock size={14} aria-hidden="true" />
          <span style={{ flex: 1 }}>Automations</span>
          {automationsCount > 0 && (
            <span className="mono tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {automationsCount}
            </span>
          )}
        </button>

        <button
          type="button"
          className="sidebar-nav-btn pressable hover-surface"
          data-active={centerView === 'skills'}
          onClick={() => onNavigateView('skills')}
        >
          <Sparkles size={14} aria-hidden="true" />
          <span style={{ flex: 1 }}>Skills</span>
          {skillsCount > 0 && (
            <span className="mono tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {skillsCount}
            </span>
          )}
        </button>
      </div>

      {/* Threads Header + Search/Filter/Add Workspace */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px 4px',
          borderTop: '1px solid var(--border-subtle)',
          gap: 4,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--text-muted)',
          }}
        >
          Threads
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={() => setSearchOpen((v) => !v)}
            aria-label="Search and filter threads"
            title="Filter & sort threads"
            style={{
              width: 26,
              height: 26,
              border: 'none',
              borderRadius: 7,
              background: searchOpen ? 'var(--bg-surface-active)' : 'transparent',
              color: 'var(--text-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Search size={13} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="pressable hover-surface titlebar-icon-btn"
            data-active={filterMode === 'unread'}
            onClick={() => setFilterMode((m) => (m === 'all' ? 'unread' : 'all'))}
            aria-label={filterMode === 'unread' ? 'Show all threads' : 'Show unread threads'}
            title={filterMode === 'unread' ? 'Showing unread' : 'Filter unread'}
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: filterMode === 'unread' ? 'var(--accent-blue-soft)' : 'transparent',
              color: filterMode === 'unread' ? 'var(--accent-blue)' : 'var(--text-secondary)',
            }}
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="pressable hover-surface"
            onClick={onAddProject}
            aria-label="Open repository folder"
            title="Add project folder"
            style={{
              width: 26,
              height: 26,
              border: 'none',
              borderRadius: 7,
              background: 'transparent',
              color: 'var(--text-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <FolderPlus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div style={{ padding: '4px 10px 6px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div
            className="codex-input-shell"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 8px',
              borderRadius: 7,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-canvas)',
            }}
          >
            <Search size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter threads..."
              aria-label="Filter threads by title"
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                outline: 'none',
                fontSize: 12,
                minWidth: 0,
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear filter"
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  color: 'var(--text-muted)',
                  display: 'inline-flex',
                  cursor: 'pointer',
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
            <span>Sort by</span>
            <button
              type="button"
              onClick={() => setSortBy((s) => (s === 'updated' ? 'created' : 'updated'))}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 11,
                cursor: 'pointer',
                padding: '1px 4px',
              }}
            >
              {sortBy === 'updated' ? 'Last updated' : 'Date created'}
            </button>
          </div>
        </div>
      )}

      {/* Scrollable Pinned + Workspace Thread Tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 10px' }}>
        {pinnedThreads.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                padding: '3px 8px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-muted)',
              }}
            >
              Pinned
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {pinnedThreads.map((th) => (
                <ThreadRow
                  key={`pin-${th.id}`}
                  thread={th}
                  active={centerView === 'thread' && th.id === activeThreadId}
                  onSelect={() => onSelectThread(th.id)}
                  onRename={(title) => onRenameThread(th.id, title)}
                  onTogglePin={() => onTogglePin(th)}
                  onArchive={() => onArchiveThread(th.id, true)}
                  onDelete={() => onDeleteThread(th.id)}
                />
              ))}
            </div>
          </div>
        )}

        {projects.length === 0 ? (
          <div
            style={{
              padding: '20px 10px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 12.5,
            }}
          >
            <p style={{ margin: '0 0 10px 0' }}>No project folder added yet.</p>
            <button
              type="button"
              className="pressable"
              onClick={onAddProject}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontSize: 12.5,
                fontWeight: 500,
              }}
            >
              Open folder
            </button>
          </div>
        ) : (
          projects.map((project) => {
            const projectThreads = filteredThreads.filter(
              (t) => t.projectId === project.id && !t.pinned,
            );
            const open = !project.collapsed;
            const menuOpen = projectMenuId === project.id;

            return (
              <div key={project.id} style={{ marginBottom: 6, position: 'relative' }}>
                <div
                  className="hover-reveal-parent"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 6px',
                  }}
                >
                  <button
                    type="button"
                    className="pressable"
                    onClick={() => onToggleProject(project.id, !project.collapsed)}
                    aria-expanded={open}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      color: 'var(--text-primary)',
                      fontSize: 12.5,
                      fontWeight: 600,
                    }}
                  >
                    <ChevronRight
                      size={13}
                      className="chevron-rotator"
                      data-open={open}
                      style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                      aria-hidden="true"
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {project.name}
                    </span>
                  </button>

                  <div className="hover-reveal-actions" style={{ display: 'flex', gap: 1 }}>
                    <button
                      type="button"
                      className="pressable hover-surface"
                      onClick={() => onNewThread(project.id)}
                      aria-label={`New thread in ${project.name}`}
                      title={`New thread in ${project.name}`}
                      style={{
                        width: 22,
                        height: 22,
                        border: 'none',
                        borderRadius: 5,
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Plus size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="pressable hover-surface"
                      onClick={() => setProjectMenuId(menuOpen ? null : project.id)}
                      aria-label={`Workspace options for ${project.name}`}
                      style={{
                        width: 22,
                        height: 22,
                        border: 'none',
                        borderRadius: 5,
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <MoreHorizontal size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {menuOpen && (
                  <div
                    className="codex-popover glass-popover"
                    role="menu"
                    style={{
                      position: 'absolute',
                      right: 6,
                      top: 28,
                      width: 170,
                      padding: 4,
                      borderRadius: 9,
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-default)',
                      boxShadow: 'var(--shadow-popover)',
                      zIndex: 'var(--z-popover)',
                      '--transform-origin': 'top right',
                    } as React.CSSProperties}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="pressable hover-surface"
                      onClick={() => {
                        setProjectMenuId(null);
                        onOpenProjectEnv(project.id);
                      }}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        border: 'none',
                        borderRadius: 6,
                        background: 'transparent',
                        textAlign: 'left',
                        fontSize: 12,
                      }}
                    >
                      Environment setup
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="pressable hover-surface"
                      onClick={() => {
                        setProjectMenuId(null);
                        onRemoveProject(project.id);
                      }}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        border: 'none',
                        borderRadius: 6,
                        background: 'transparent',
                        textAlign: 'left',
                        fontSize: 12,
                        color: 'var(--accent-red)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      <span>Remove workspace</span>
                    </button>
                  </div>
                )}

                {open && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 6 }}>
                    {projectThreads.map((th) => (
                      <ThreadRow
                        key={th.id}
                        thread={th}
                        active={centerView === 'thread' && th.id === activeThreadId}
                        onSelect={() => onSelectThread(th.id)}
                        onRename={(title) => onRenameThread(th.id, title)}
                        onTogglePin={() => onTogglePin(th)}
                        onArchive={() => onArchiveThread(th.id, true)}
                        onDelete={() => onDeleteThread(th.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Bottom Footer */}
      <div
        style={{
          padding: '8px 10px',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {archivedCount > 0 && (
          <button
            type="button"
            className="sidebar-nav-btn pressable hover-surface"
            data-active={centerView === 'archived'}
            onClick={() => onNavigateView('archived')}
          >
            <Archive size={14} aria-hidden="true" />
            <span style={{ flex: 1 }}>Archived</span>
            <span className="mono tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {archivedCount}
            </span>
          </button>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="sidebar-nav-btn pressable hover-surface"
            data-active={centerView === 'settings'}
            onClick={() => onNavigateView('settings')}
            style={{ flex: 1 }}
          >
            <Settings size={14} aria-hidden="true" />
            <span>Settings</span>
          </button>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={onOpenShortcuts}
            aria-label="Keyboard shortcuts (Ctrl+/)"
            title="Keyboard shortcuts (Ctrl+/)"
            style={{
              width: 30,
              height: 30,
              border: 'none',
              borderRadius: 7,
              background: 'transparent',
              color: 'var(--text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <HelpCircle size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
