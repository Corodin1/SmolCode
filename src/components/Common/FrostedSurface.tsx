import type { ReactNode } from 'react';

export type FrostedVariant = 'composer' | 'pill' | 'popover' | 'palette' | 'modal';

export interface FrostedSurfaceProps {
  variant: FrostedVariant;
  cornerRadius?: number;
  className?: string;
  style?: React.CSSProperties;
  asButton?: boolean;
  onClick?: React.MouseEventHandler<HTMLElement>;
  onMouseDown?: React.MouseEventHandler<HTMLElement>;
  role?: React.AriaRole;
  'aria-label'?: string;
  'aria-live'?: 'off' | 'polite' | 'assertive';
  'aria-modal'?: boolean;
  children: ReactNode;
}

/**
 * Pure-CSS Hermes-inspired transparent blur surface with subtle accent color shift,
 * GPU-composited `backdrop-filter`, and crisp hairline elevation.
 */
export function FrostedSurface({
  variant,
  cornerRadius,
  className = '',
  style,
  asButton = false,
  onClick,
  onMouseDown,
  role,
  'aria-label': ariaLabel,
  'aria-live': ariaLive,
  'aria-modal': ariaModal,
  children,
}: FrostedSurfaceProps) {
  const mergedStyle: React.CSSProperties =
    cornerRadius !== undefined ? { borderRadius: cornerRadius, ...style } : { ...style };

  if (asButton) {
    return (
      <button
        type="button"
        className={`codex-frosted-surface ${className}`.trim()}
        data-frosted-variant={variant}
        onClick={onClick as React.MouseEventHandler<HTMLButtonElement>}
        onMouseDown={onMouseDown as React.MouseEventHandler<HTMLButtonElement>}
        aria-label={ariaLabel}
        style={mergedStyle}
      >
        {children}
      </button>
    );
  }

  return (
    <div
      role={role}
      aria-label={ariaLabel}
      aria-live={ariaLive}
      aria-modal={ariaModal}
      className={`codex-frosted-surface ${className}`.trim()}
      data-frosted-variant={variant}
      onClick={onClick as React.MouseEventHandler<HTMLDivElement>}
      onMouseDown={onMouseDown as React.MouseEventHandler<HTMLDivElement>}
      style={mergedStyle}
    >
      {children}
    </div>
  );
}
