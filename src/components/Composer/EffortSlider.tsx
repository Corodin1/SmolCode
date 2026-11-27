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

interface GlintParticle {
  x: number;
  y: number;
  size: number;
  duration: number;
  delay: number;
}

interface BurstSpark {
  dx: number;
  dy: number;
  angle: number;
  length: number;
  duration: number;
  delay: number;
  tone: 'violet' | 'blue' | 'core';
}

const ULTRA_STARS: readonly StarParticle[] = [
  { x: 6, y: 32, size: 2.5, opacity: 0.92, duration: 2.1, delay: 0, driftX: 14, driftY: -3 },
  { x: 10, y: 70, size: 1.7, opacity: 0.68, duration: 2.8, delay: -0.9, driftX: 11, driftY: 3 },
  { x: 15, y: 48, size: 3.3, opacity: 0.96, duration: 2.4, delay: -1.6, driftX: 16, driftY: 2 },
  { x: 21, y: 24, size: 2.0, opacity: 0.75, duration: 1.9, delay: -0.4, driftX: 13, driftY: 2 },
  { x: 26, y: 76, size: 2.6, opacity: 0.88, duration: 3.0, delay: -2.1, driftX: 15, driftY: -3 },
  { x: 32, y: 38, size: 1.8, opacity: 0.78, duration: 2.3, delay: -1.1, driftX: 10, driftY: 3 },
  { x: 38, y: 60, size: 3.4, opacity: 0.94, duration: 2.6, delay: -0.6, driftX: 17, driftY: -2 },
  { x: 44, y: 26, size: 2.1, opacity: 0.74, duration: 2.0, delay: -1.8, driftX: 12, driftY: 3 },
  { x: 50, y: 72, size: 2.8, opacity: 0.9, duration: 2.5, delay: -0.3, driftX: 14, driftY: -3 },
  { x: 55, y: 42, size: 1.7, opacity: 0.7, duration: 2.9, delay: -2.4, driftX: 16, driftY: 2 },
  { x: 61, y: 24, size: 3.1, opacity: 0.95, duration: 2.2, delay: -1.3, driftX: 12, driftY: 3 },
  { x: 66, y: 64, size: 2.2, opacity: 0.8, duration: 2.4, delay: -0.7, driftX: 14, driftY: -2 },
  { x: 72, y: 36, size: 3.2, opacity: 0.92, duration: 2.7, delay: -1.9, driftX: 13, driftY: 3 },
  { x: 77, y: 75, size: 2.3, opacity: 0.84, duration: 2.1, delay: -1.0, driftX: 11, driftY: -3 },
  { x: 82, y: 46, size: 1.9, opacity: 0.76, duration: 2.5, delay: -1.5, driftX: 9, driftY: 2 },
  { x: 13, y: 20, size: 1.5, opacity: 0.62, duration: 3.2, delay: -0.5, driftX: 12, driftY: 2 },
  { x: 47, y: 50, size: 2.0, opacity: 0.82, duration: 1.8, delay: -1.2, driftX: 15, driftY: -2 },
  { x: 70, y: 52, size: 1.6, opacity: 0.66, duration: 2.6, delay: -2.2, driftX: 12, driftY: 2 },
];

const ULTRA_GLINTS: readonly GlintParticle[] = [
  { x: 22, y: 46, size: 8, duration: 2.3, delay: -0.4 },
  { x: 53, y: 34, size: 9, duration: 2.7, delay: -1.5 },
  { x: 76, y: 56, size: 7.5, duration: 2.1, delay: -0.9 },
];

const ULTRA_BURST_SPARKS: readonly BurstSpark[] = [
  { dx: -26, dy: -22, angle: -140, length: 9, duration: 480, delay: 0, tone: 'violet' },
  { dx: -10, dy: -30, angle: -108, length: 10, duration: 520, delay: 15, tone: 'core' },
  { dx: 14, dy: -28, angle: -64, length: 9, duration: 490, delay: 25, tone: 'blue' },
  { dx: 29, dy: -16, angle: -28, length: 11, duration: 540, delay: 10, tone: 'violet' },
  { dx: 34, dy: 2, angle: 4, length: 10, duration: 500, delay: 20, tone: 'core' },
  { dx: 27, dy: 20, angle: 36, length: 9, duration: 530, delay: 0, tone: 'blue' },
  { dx: 11, dy: 29, angle: 69, length: 10, duration: 510, delay: 30, tone: 'violet' },
  { dx: -14, dy: 28, angle: 116, length: 8, duration: 470, delay: 15, tone: 'core' },
  { dx: -29, dy: 16, angle: 151, length: 9, duration: 520, delay: 20, tone: 'blue' },
  { dx: -36, dy: -3, angle: 185, length: 11, duration: 495, delay: 5, tone: 'violet' },
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
  const [ultraBurstCount, setUltraBurstCount] = useState(0);

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

  const selectTier = (nextValue: EffortLevel) => {
    if (nextValue === 'xhigh' && value !== 'xhigh') {
      setUltraBurstCount((c) => c + 1);
    }
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

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
    if (target) {
      selectTier(target.value);
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
      if (target) selectTier(target.value);
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

      <div className="codex-effort-track-wrap">
        {/* One-shot themed shockwave & sparks anchored on the Ultra thumb */}
        {isUltra && ultraBurstCount > 0 && (
          <div key={ultraBurstCount} className="codex-effort-ultra-burst" aria-hidden="true">
            <span className="codex-effort-track-shockwave" />
            <span className="codex-effort-shockwave" />
            <span className="codex-effort-shockwave-inner" />
            {ULTRA_BURST_SPARKS.map((spark, i) => (
              <span
                key={i}
                className="codex-effort-spark"
                data-tone={spark.tone}
                style={
                  {
                    width: spark.length,
                    '--spark-x': `${spark.dx}px`,
                    '--spark-y': `${spark.dy}px`,
                    '--spark-angle': `${spark.angle}deg`,
                    '--spark-duration': `${spark.duration}ms`,
                    '--spark-delay': `${spark.delay}ms`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        )}

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
                <div className="codex-effort-nebula codex-effort-nebula-a" />
                <div className="codex-effort-nebula codex-effort-nebula-b" />
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
                  {ULTRA_GLINTS.map((glint, i) => (
                    <svg
                      key={`glint-${i}`}
                      viewBox="0 0 16 16"
                      className="codex-effort-glint"
                      style={
                        {
                          left: `${glint.x}%`,
                          top: `${glint.y}%`,
                          width: glint.size,
                          height: glint.size,
                          '--glint-duration': `${glint.duration}s`,
                          '--glint-delay': `${glint.delay}s`,
                        } as React.CSSProperties
                      }
                    >
                      <path
                        d="M8 0L9.8 6.2L16 8L9.8 9.8L8 16L6.2 9.8L0 8L6.2 6.2Z"
                        fill="currentColor"
                      />
                    </svg>
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
                    selectTier(tier.value);
                  }}
                />
              );
            })}
          </div>
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
