import { Zap } from 'lucide-react';
import { useRef, useState } from 'react';
import type { EffortLevel } from '../../shared/types';

export interface EffortTierMeta {
  value: EffortLevel;
  label: string;
  shortLabel: string;
  hint: string;
  computeBadge: string;
  colorToken: string;
}

export const EFFORT_TIERS: EffortTierMeta[] = [
  {
    value: 'low',
    label: 'Low',
    shortLabel: 'Low',
    hint: 'Simple, short code and fast direct edits',
    computeBadge: '8k ctx · 2k out',
    colorToken: 'var(--effort-low)',
  },
  {
    value: 'medium',
    label: 'Medium',
    shortLabel: 'Medium',
    hint: 'Clean, balanced code with targeted checks',
    computeBadge: '12k ctx · 3k out',
    colorToken: 'var(--effort-medium)',
  },
  {
    value: 'high',
    label: 'High',
    shortLabel: 'High',
    hint: 'Modular code, edge cases, and focused tests',
    computeBadge: '16k ctx · 4.6k out',
    colorToken: 'var(--effort-high)',
  },
  {
    value: 'xhigh',
    label: 'Ultra',
    shortLabel: 'Ultra',
    hint: 'Refined architecture, polish, and full-audit checks',
    computeBadge: '24k ctx · 8k out',
    colorToken: 'var(--effort-xhigh)',
  },
];

interface StarParticle {
  x: number;
  y: number;
  size: number;
  opacity: number;
  duration: number;
  delay: number;
  driftX: number;
  driftY: number;
}

const ULTRA_STARS: readonly StarParticle[] = [
  { x: 7, y: 34, size: 2.5, opacity: 0.9, duration: 2.4, delay: 0, driftX: 4, driftY: -2 },
  { x: 11, y: 66, size: 1.8, opacity: 0.65, duration: 3.1, delay: -0.9, driftX: 3, driftY: 2 },
  { x: 17, y: 46, size: 3.2, opacity: 0.95, duration: 2.8, delay: -1.6, driftX: -3, driftY: 2 },
  { x: 24, y: 28, size: 2, opacity: 0.72, duration: 2.2, delay: -0.4, driftX: 5, driftY: 1 },
  { x: 29, y: 72, size: 2.4, opacity: 0.85, duration: 3.4, delay: -2.1, driftX: 4, driftY: -2 },
  { x: 37, y: 36, size: 1.9, opacity: 0.78, duration: 2.6, delay: -1.1, driftX: -4, driftY: 2 },
  { x: 45, y: 58, size: 3.4, opacity: 0.92, duration: 3.0, delay: -0.6, driftX: 4, driftY: -1 },
  { x: 52, y: 32, size: 2.2, opacity: 0.7, duration: 2.3, delay: -1.8, driftX: 3, driftY: 2 },
  { x: 58, y: 68, size: 2.7, opacity: 0.88, duration: 2.9, delay: -0.3, driftX: -3, driftY: -2 },
  { x: 64, y: 42, size: 1.8, opacity: 0.68, duration: 3.2, delay: -2.4, driftX: 5, driftY: 1 },
  { x: 71, y: 26, size: 2.9, opacity: 0.95, duration: 2.5, delay: -1.3, driftX: 3, driftY: 2 },
  { x: 77, y: 62, size: 2.1, opacity: 0.76, duration: 2.7, delay: -0.7, driftX: -4, driftY: -1 },
  { x: 83, y: 38, size: 3.1, opacity: 0.9, duration: 3.3, delay: -1.9, driftX: 3, driftY: 2 },
  { x: 88, y: 74, size: 2.3, opacity: 0.82, duration: 2.4, delay: -1.0, driftX: -3, driftY: -2 },
];

export function EffortSignalIcon({
  level,
  size = 13,
}: {
  level: EffortLevel;
  size?: number;
}) {
  const idx = Math.max(0, EFFORT_TIERS.findIndex((t) => t.value === level));
  const tier = EFFORT_TIERS[idx] ?? EFFORT_TIERS[1];
  const barHeights = [4, 7, 10, 13];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {barHeights.map((h, i) => {
        const active = i <= idx;
        return (
          <rect
            key={i}
            x={1.5 + i * 3.6}
            y={14 - h}
            width={2.3}
            height={h}
            rx={1}
            fill={active ? tier.colorToken : 'var(--border-strong)'}
            opacity={active ? 1 : 0.45}
            style={{ transition: 'fill 180ms var(--ease-out), opacity 180ms var(--ease-out)' }}
          />
        );
      })}
    </svg>
  );
}

interface EffortSliderProps {
  value: EffortLevel;
  onChange: (next: EffortLevel) => void;
  variant?: 'popover' | 'inline';
}

export function EffortSlider({
  value,
  onChange,
  variant = 'popover',
}: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pointerDownXRef = useRef<number | null>(null);
  const isPointerDraggingRef = useRef(false);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const maxIdx = EFFORT_TIERS.length - 1;
  const selectedIdx = Math.max(
    0,
    EFFORT_TIERS.findIndex((t) => t.value === value),
  );
  const activeFloatIdx = draggingIdx !== null ? draggingIdx : selectedIdx;
  const snappedIdx = Math.min(maxIdx, Math.max(0, Math.round(activeFloatIdx)));
  const previewIdx = hoveredIdx !== null && draggingIdx === null ? hoveredIdx : snappedIdx;
  const activeTier = EFFORT_TIERS[snappedIdx] ?? EFFORT_TIERS[1];
  const previewTier = EFFORT_TIERS[previewIdx] ?? activeTier;

  const progress = activeFloatIdx / maxIdx;

  const computeFloatIndexFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return selectedIdx;
    const rect = el.getBoundingClientRect();
    const usable = Math.max(1, rect.width - 36);
    const rel = (clientX - (rect.left + 18)) / usable;
    return Math.min(maxIdx, Math.max(0, rel * maxIdx));
  };

  const commitRoundedIndex = (floatIdx: number) => {
    const rounded = Math.min(maxIdx, Math.max(0, Math.round(floatIdx)));
    const target = EFFORT_TIERS[rounded];
    if (target && target.value !== value) {
      onChange(target.value);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    pointerDownXRef.current = e.clientX;
    isPointerDraggingRef.current = false;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerDownXRef.current === null) return;
    if (!isPointerDraggingRef.current && Math.abs(e.clientX - pointerDownXRef.current) > 4) {
      isPointerDraggingRef.current = true;
      trackRef.current?.setPointerCapture?.(e.pointerId);
    }
    if (!isPointerDraggingRef.current) return;
    const nextFloat = computeFloatIndexFromClientX(e.clientX);
    setDraggingIdx(nextFloat);
    commitRoundedIndex(nextFloat);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerDownXRef.current === null) return;
    const wasDragging = isPointerDraggingRef.current;
    pointerDownXRef.current = null;
    isPointerDraggingRef.current = false;
    if (wasDragging) {
      const nextFloat = draggingIdx ?? computeFloatIndexFromClientX(e.clientX);
      setDraggingIdx(null);
      trackRef.current?.releasePointerCapture?.(e.pointerId);
      commitRoundedIndex(nextFloat);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      nextIdx = Math.min(maxIdx, selectedIdx + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      nextIdx = Math.max(0, selectedIdx - 1);
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = maxIdx;
    }
    if (nextIdx !== null) {
      e.preventDefault();
      const target = EFFORT_TIERS[nextIdx];
      if (target) onChange(target.value);
    }
  };

  const isUltra = activeTier.value === 'xhigh';

  return (
    <div
      className="codex-effort-slider"
      data-tier={activeTier.value}
      data-variant={variant}
    >
      <div className="codex-effort-header">
        <div className="codex-effort-header-left">
          <Zap
            size={13.5}
            className="codex-effort-bolt"
            data-ultra={isUltra ? 'true' : 'false'}
            aria-hidden="true"
          />
          <span className="codex-effort-title">Reasoning</span>
        </div>
        <span
          className="codex-effort-tier-readout"
          data-ultra={previewTier.value === 'xhigh' ? 'true' : 'false'}
          style={{
            color:
              previewTier.value === 'xhigh'
                ? 'var(--effort-xhigh)'
                : previewTier.value === 'low'
                  ? 'var(--text-secondary)'
                  : 'var(--text-primary)',
          }}
        >
          {previewTier.label}
        </span>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={maxIdx}
        aria-valuenow={selectedIdx}
        aria-valuetext={activeTier.label}
        className="codex-effort-track"
        data-dragging={draggingIdx !== null ? 'true' : 'false'}
        data-tier={activeTier.value}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {/* Progressive capsule fill clipped cleanly up to thumb edge */}
        <div
          className="codex-effort-fill"
          data-tier={activeTier.value}
          aria-hidden="true"
          style={{
            opacity: progress <= 0.01 ? 0 : 1,
            clipPath: `inset(0 calc((1 - ${progress}) * (100% - 34px)) 0 0 round 9999px)`,
            transition: draggingIdx !== null ? 'none' : undefined,
          }}
        >
          {isUltra && (
            <>
              <div className="codex-effort-ultra-sheen" />
              <div className="codex-effort-stars">
                {ULTRA_STARS.map((star, i) => (
                  <span
                    key={i}
                    className="codex-effort-star"
                    style={
                      {
                        left: `${star.x}%`,
                        top: `${star.y}%`,
                        width: star.size,
                        height: star.size,
                        '--star-opacity': star.opacity,
                        '--star-duration': `${star.duration}s`,
                        '--star-delay': `${star.delay}s`,
                        '--star-dx': `${star.driftX}px`,
                        '--star-dy': `${star.driftY}px`,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Stop dots centered along the thumb rail */}
        <div className="codex-effort-dots" aria-hidden="true">
          {EFFORT_TIERS.map((tier, idx) => {
            const isCovered = idx === snappedIdx && draggingIdx === null;
            const isHovered = hoveredIdx === idx;
            const isPassed = idx < snappedIdx;
            return (
              <span
                key={tier.value}
                className="codex-effort-dot-stop"
                data-covered={isCovered ? 'true' : 'false'}
                data-hovered={isHovered ? 'true' : 'false'}
                data-passed={isPassed ? 'true' : 'false'}
                style={{ left: `${(idx / maxIdx) * 100}%` }}
              />
            );
          })}
        </div>

        {/* Circular white thumb gliding along [18px .. width-18px] */}
        <div className="codex-effort-rail" aria-hidden="true">
          <div
            className="codex-effort-thumb-mover"
            style={{
              transform: `translateX(${progress * 100}%)`,
              transition: draggingIdx !== null ? 'none' : undefined,
            }}
          >
            <div className="codex-effort-thumb" data-ultra={isUltra ? 'true' : 'false'} />
          </div>
        </div>

        {/* Accessible clickable stop targets */}
        <div className="codex-effort-stops">
          {EFFORT_TIERS.map((tier, idx) => {
            const isSelected = idx === snappedIdx;
            return (
              <button
                key={tier.value}
                type="button"
                tabIndex={-1}
                aria-label={tier.label}
                aria-pressed={isSelected}
                title={tier.label}
                className="codex-effort-stop"
                data-active={isSelected ? 'true' : 'false'}
                onMouseEnter={() => setHoveredIdx(idx)}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onChange(tier.value);
                }}
              />
            );
          })}
        </div>
      </div>

      {variant === 'inline' && (
        <div className="codex-effort-footer">
          <span style={{ color: 'var(--text-secondary)', fontSize: 11.5, flex: 1 }}>
            {previewTier.hint}
          </span>
          <span
            className="mono tabular-nums"
            style={{
              fontSize: 10.5,
              color: previewTier.colorToken,
              flexShrink: 0,
            }}
          >
            {previewTier.computeBadge}
          </span>
        </div>
      )}
    </div>
  );
}
