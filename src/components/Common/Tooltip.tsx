import { useEffect, useRef, useState, type ReactNode } from 'react';

// Shared module-level timestamp so adjacent tooltips open instantaneously
// after the user has already hovered one toolbar control (Emil Kowalski rule).
let lastTooltipClosedAt = 0;
let activeTooltipCount = 0;

interface TooltipProps {
  label: string;
  shortcut?: string;
  placement?: 'top' | 'bottom';
  children: ReactNode;
}

export function Tooltip({
  label,
  shortcut,
  placement = 'bottom',
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const handleEnter = () => {
    clearTimer();
    const recentlyOpen = activeTooltipCount > 0 || Date.now() - lastTooltipClosedAt < 600;
    if (recentlyOpen) {
      setInstant(true);
      activeTooltipCount += 1;
      setOpen(true);
    } else {
      setInstant(false);
      timerRef.current = setTimeout(() => {
        activeTooltipCount += 1;
        setOpen(true);
      }, 360);
    }
  };

  const handleLeave = () => {
    clearTimer();
    if (open) {
      activeTooltipCount = Math.max(0, activeTooltipCount - 1);
      lastTooltipClosedAt = Date.now();
    }
    setOpen(false);
  };

  const origin = placement === 'top' ? 'bottom center' : 'top center';

  return (
    <span
      className="codex-tooltip-anchor"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleEnter}
      onBlur={handleLeave}
      onPointerDown={handleLeave}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className="codex-tooltip glass-popover"
          data-placement={placement}
          data-instant={instant ? 'true' : 'false'}
          style={{ '--transform-origin': origin } as React.CSSProperties}
        >
          <span>{label}</span>
          {shortcut && <kbd className="mono codex-tooltip-kbd">{shortcut}</kbd>}
        </span>
      )}
    </span>
  );
}
