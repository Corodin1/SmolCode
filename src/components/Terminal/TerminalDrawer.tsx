import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Eraser, MessageSquarePlus, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../shared/types';

interface TerminalDrawerProps {
  threadId: string | null;
  height: number;
  theme: 'light' | 'dark';
  defaultShell: AppSettings['defaultShell'];
  onSendSelectionToComposer: (snippet: string) => void;
  onClose: () => void;
}

interface TermTab {
  id: string;
  label: string;
  shellPref: AppSettings['defaultShell'];
}

export function TerminalDrawer({
  threadId,
  height,
  theme,
  defaultShell,
  onSendSelectionToComposer,
  onClose,
}: TerminalDrawerProps) {
  const [tabs, setTabs] = useState<TermTab[]>([
    { id: 'tab-1', label: 'Terminal 1', shellPref: defaultShell },
  ]);
  const [activeTabId, setActiveTabId] = useState('tab-1');
  const [shellPref, setShellPref] = useState<AppSettings['defaultShell']>(defaultShell);

  const hostMapRef = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const termMapRef = useRef<Map<string, { term: Terminal; fit: FitAddon; ptyId: string | null }>>(
    new Map(),
  );
  const initialThemeRef = useRef(theme);
  const tabCounter = useRef(2);

  const mountTab = useCallback(
    (tab: TermTab, container: HTMLDivElement) => {
      if (!threadId || !window.smolcode || termMapRef.current.has(tab.id)) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12.5,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
        theme:
          initialThemeRef.current === 'light'
            ? { background: '#f7f7f8', foreground: '#111216', cursor: '#111216' }
            : { background: '#0e0e10', foreground: '#f5f5f7', cursor: '#f5f5f7' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(container);
      fitAddon.fit();

      const record: { term: Terminal; fit: FitAddon; ptyId: string | null } = {
        term,
        fit: fitAddon,
        ptyId: null,
      };
      termMapRef.current.set(tab.id, record);

      void window.smolcode
        .spawnTerminal({
          threadId,
          cols: term.cols,
          rows: term.rows,
          shellPref: tab.shellPref,
        })
        .then((res) => {
          record.ptyId = res.ptyId;
          setTabs((prev) =>
            prev.map((t) => (t.id === tab.id ? { ...t, label: res.shell } : t)),
          );
        });

      const unsub = window.smolcode.onTerminalData((payload) => {
        if (payload.ptyId === record.ptyId) term.write(payload.data);
      });

      const disp = term.onData((d) => {
        if (record.ptyId) void window.smolcode.writeTerminal(record.ptyId, d);
      });

      const ro = new ResizeObserver(() => {
        fitAddon.fit();
        if (record.ptyId) {
          void window.smolcode.resizeTerminal(record.ptyId, term.cols, term.rows);
        }
      });
      ro.observe(container);

      const cleanup = () => {
        ro.disconnect();
        disp.dispose();
        unsub();
        if (record.ptyId) void window.smolcode.closeTerminal(record.ptyId);
        term.dispose();
        termMapRef.current.delete(tab.id);
      };
      (container as unknown as { __cleanup?: () => void }).__cleanup = cleanup;
    },
    [threadId],
  );

  useEffect(() => {
    for (const tab of tabs) {
      const host = hostMapRef.current.get(tab.id);
      if (host && !termMapRef.current.has(tab.id)) {
        mountTab(tab, host);
      }
    }
  }, [tabs, mountTab]);

  useEffect(() => {
    const hosts = hostMapRef.current;
    return () => {
      for (const host of hosts.values()) {
        (host as unknown as { __cleanup?: () => void } | null)?.__cleanup?.();
      }
    };
  }, [threadId]);

  useEffect(() => {
    for (const entry of termMapRef.current.values()) {
      entry.term.options.theme =
        theme === 'light'
          ? { background: '#f7f7f8', foreground: '#111216', cursor: '#111216' }
          : { background: '#0e0e10', foreground: '#f5f5f7', cursor: '#f5f5f7' };
    }
  }, [theme]);

  useEffect(() => {
    const active = termMapRef.current.get(activeTabId);
    active?.fit.fit();
  }, [height, activeTabId]);

  const addTab = () => {
    const id = `tab-${tabCounter.current++}`;
    setTabs((prev) => [...prev, { id, label: 'Terminal', shellPref }]);
    setActiveTabId(id);
  };

  const closeTab = (id: string) => {
    const host = hostMapRef.current.get(id);
    (host as unknown as { __cleanup?: () => void } | null)?.__cleanup?.();
    hostMapRef.current.delete(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        onClose();
        return prev;
      }
      if (activeTabId === id) setActiveTabId(next[0].id);
      return next;
    });
  };

  const clearActive = () => {
    termMapRef.current.get(activeTabId)?.term.clear();
  };

  const sendSelection = () => {
    const entry = termMapRef.current.get(activeTabId);
    if (!entry) return;
    const sel = entry.term.getSelection().trim();
    if (sel) {
      onSendSelectionToComposer(sel);
      return;
    }
    const buf = entry.term.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buf.cursorY - 25);
    for (let i = start; i <= buf.cursorY; i++) {
      const line = buf.getLine(i)?.translateToString(true);
      if (line) lines.push(line);
    }
    if (lines.length > 0) {
      onSendSelectionToComposer(lines.join('\n'));
    }
  };

  return (
    <section
      aria-label="Integrated terminal"
      style={{
        height,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-sidebar)',
      }}
    >
      <div
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
          borderBottom: '1px solid var(--border-subtle)',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, overflowX: 'auto', minWidth: 0 }}>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  height: 24,
                  padding: '0 6px 0 8px',
                  borderRadius: 6,
                  background: active ? 'var(--bg-surface-active)' : 'transparent',
                  border: active ? '1px solid var(--border-subtle)' : '1px solid transparent',
                  fontSize: 11.5,
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    fontSize: 11.5,
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab.id)}
                  aria-label={`Close ${tab.label}`}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    padding: 1,
                    display: 'inline-flex',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            className="pressable hover-surface"
            onClick={addTab}
            aria-label="New terminal tab"
            title="New terminal tab"
            style={{
              width: 24,
              height: 24,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <select
            value={shellPref}
            onChange={(e) => setShellPref(e.target.value as AppSettings['defaultShell'])}
            aria-label="Shell for new terminal tabs"
            style={{
              height: 22,
              padding: '0 5px',
              borderRadius: 5,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              fontSize: 11,
            }}
          >
            <option value="auto">Auto</option>
            <option value="pwsh">pwsh</option>
            <option value="powershell">PowerShell</option>
            <option value="git-bash">Git Bash</option>
            <option value="wsl">WSL</option>
          </select>

          <button
            type="button"
            className="pressable hover-surface"
            onClick={sendSelection}
            title="Send selected or recent terminal output to Composer"
            style={{
              height: 22,
              padding: '0 7px',
              borderRadius: 5,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              fontSize: 11,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <MessageSquarePlus size={11} aria-hidden="true" />
            <span>To chat</span>
          </button>

          <button
            type="button"
            className="pressable hover-surface"
            onClick={clearActive}
            aria-label="Clear terminal"
            title="Clear"
            style={{
              width: 26,
              height: 26,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Eraser size={12} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="pressable hover-surface"
            onClick={onClose}
            aria-label="Close terminal drawer"
            style={{
              width: 26,
              height: 26,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-muted)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(el) => {
              hostMapRef.current.set(tab.id, el);
            }}
            style={{
              position: 'absolute',
              inset: '4px 8px',
              display: tab.id === activeTabId ? 'block' : 'none',
            }}
          />
        ))}
      </div>
    </section>
  );
}
