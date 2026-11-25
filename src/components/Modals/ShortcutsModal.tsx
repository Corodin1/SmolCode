import { X } from 'lucide-react';

interface ShortcutsModalProps {
  onClose: () => void;
}

export const KEYBOARD_SHORTCUTS: Array<{ keys: string; action: string; group: string }> = [
  { group: 'Workspace', keys: 'Ctrl + N', action: 'New thread in active project' },
  { group: 'Workspace', keys: 'Ctrl + K', action: 'Open Command Palette' },
  { group: 'Workspace', keys: 'Ctrl + ,', action: 'Open Settings' },
  { group: 'Workspace', keys: 'Ctrl + /', action: 'Keyboard shortcuts' },
  { group: 'Navigation', keys: 'Ctrl + B', action: 'Toggle left sidebar' },
  { group: 'Navigation', keys: 'Ctrl + J', action: 'Toggle integrated terminal' },
  { group: 'Navigation', keys: 'Ctrl + Shift + M', action: 'Toggle compact pop-out window' },
  { group: 'Composer', keys: 'Shift + Tab', action: 'Switch Build / Plan mode' },
  { group: 'Composer', keys: 'Enter', action: 'Send or queue prompt' },
  { group: 'Composer', keys: 'Shift + Enter', action: 'Insert newline' },
  { group: 'Composer', keys: '@ / /', action: 'Mention files/symbols or invoke slash commands' },
];

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  const groups = ['Workspace', 'Navigation', 'Composer'];
  return (
    <div
      className="codex-modal-backdrop glass-backdrop"
      role="dialog"
      aria-label="Keyboard Shortcuts"
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 'var(--z-modal)',
      }}
    >
      <div
        className="codex-modal-card glass-popover"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: '92vw',
          borderRadius: 14,
          border: '1px solid var(--border-default)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>Keyboard Shortcuts</span>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={onClose}
            aria-label="Close shortcuts"
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

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '70vh', overflowY: 'auto' }}>
          {groups.map((grp) => (
            <div key={grp}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                {grp}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {KEYBOARD_SHORTCUTS.filter((s) => s.group === grp).map((item) => (
                  <div
                    key={item.keys}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: 'var(--text-secondary)' }}>{item.action}</span>
                    <kbd
                      className="mono"
                      style={{
                        padding: '2px 7px',
                        borderRadius: 6,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-surface)',
                        fontSize: 11,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {item.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
