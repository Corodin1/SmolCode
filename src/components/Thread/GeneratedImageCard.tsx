import { Check, Copy, Download, Maximize2, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GeneratedImageRecord } from '../../shared/types';

interface OceanParticle {
  u: number;
  v: number;
  jitterU: number;
  jitterV: number;
  phaseOffset: number;
  sizeBias: number;
}

interface OceanWaveOctave {
  kx: number;
  ky: number;
  speed: number;
  amp: number;
  driftX: number;
  driftY: number;
}

type RgbColor = [number, number, number];

interface OceanThemePalette {
  isLight: boolean;
  trough: RgbColor;
  mid: RgbColor;
  crest: RgbColor;
  causticPrimary: RgbColor;
  causticSecondary: RgbColor;
}

const OCEAN_COLS = 22;
const OCEAN_ROWS = 20;

// Calm, meditative deep-sea Gerstner wave octaves
const OCEAN_OCTAVES: readonly OceanWaveOctave[] = [
  { kx: 4.4, ky: 1.8, speed: 0.78, amp: 0.44, driftX: 0.018, driftY: 0.014 },
  { kx: -2.8, ky: 4.2, speed: 1.05, amp: 0.28, driftX: -0.012, driftY: 0.015 },
  { kx: 7.4, ky: -3.5, speed: 1.38, amp: 0.17, driftX: 0.007, driftY: -0.009 },
  { kx: 1.8, ky: 8.2, speed: 0.64, amp: 0.11, driftX: 0.004, driftY: 0.01 },
];

function hash01(seed: number): number {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

const OCEAN_PARTICLES: readonly OceanParticle[] = Array.from(
  { length: OCEAN_COLS * OCEAN_ROWS },
  (_, i) => {
    const row = Math.floor(i / OCEAN_COLS);
    const col = i % OCEAN_COLS;
    const rowShift = row % 2 === 0 ? 0 : 0.5;
    const u = -0.05 + ((col + rowShift) / (OCEAN_COLS - 0.5)) * 1.1;
    const v = -0.05 + (row / (OCEAN_ROWS - 1)) * 1.1;
    return {
      u,
      v,
      jitterU: (hash01(i * 3 + 1) - 0.5) * 0.03,
      jitterV: (hash01(i * 3 + 2) - 0.5) * 0.03,
      phaseOffset: hash01(i * 3 + 3) * 0.45,
      sizeBias: 0.8 + hash01(i * 7 + 5) * 0.42,
    };
  },
);

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: RgbColor, b: RgbColor, t: number): RgbColor {
  const k = Math.min(1, Math.max(0, t));
  return [
    Math.round(lerp(a[0], b[0], k)),
    Math.round(lerp(a[1], b[1], k)),
    Math.round(lerp(a[2], b[2], k)),
  ];
}

function parseCssColor(raw: string, fallback: RgbColor): RgbColor {
  const val = raw.trim();
  if (val.startsWith('#')) {
    const hex = val.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const rgbMatch = val.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  return fallback;
}

function resolveOceanPalette(): OceanThemePalette {
  const root = document.documentElement;
  const isLight = root.getAttribute('data-theme') === 'light';
  const styles = getComputedStyle(root);

  const brand = parseCssColor(
    styles.getPropertyValue('--accent-brand'),
    isLight ? [37, 99, 235] : [96, 165, 250],
  );
  const focus = parseCssColor(
    styles.getPropertyValue('--focus-ring'),
    isLight ? [37, 99, 235] : [147, 197, 253],
  );
  const bgSidebar = parseCssColor(
    styles.getPropertyValue('--bg-sidebar'),
    isLight ? [247, 247, 248] : [14, 14, 16],
  );
  const textMuted = parseCssColor(
    styles.getPropertyValue('--text-muted'),
    isLight ? [98, 102, 115] : [130, 132, 144],
  );

  const textPrimary = parseCssColor(
    styles.getPropertyValue('--text-primary'),
    isLight ? [17, 18, 22] : [245, 245, 247],
  );

  // Harmonize ocean ramp with the active preset & accent token
  const trough = isLight
    ? mixRgb(textMuted, brand, 0.42)
    : mixRgb(bgSidebar, brand, 0.36);
  const mid = brand;
  const crest = isLight
    ? mixRgb(focus, textPrimary, 0.2)
    : mixRgb(focus, [255, 255, 255], 0.32);

  return {
    isLight,
    trough,
    mid,
    crest,
    causticPrimary: brand,
    causticSecondary: crest,
  };
}

function drawOceanFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeSec: number,
  palette: OceanThemePalette,
) {
  ctx.clearRect(0, 0, width, height);

  const swellShiftX = Math.sin(timeSec * 0.34) * width * 0.11;
  const swellShiftY = Math.cos(timeSec * 0.28) * height * 0.09;
  const bgGrad = ctx.createRadialGradient(
    width * 0.5 + swellShiftX,
    height * 0.48 + swellShiftY,
    width * 0.04,
    width * 0.5,
    height * 0.5,
    width * 0.78,
  );
  const [cpR, cpG, cpB] = palette.causticPrimary;
  const [csR, csG, csB] = palette.causticSecondary;
  if (palette.isLight) {
    bgGrad.addColorStop(0, `rgba(${cpR}, ${cpG}, ${cpB}, 0.075)`);
    bgGrad.addColorStop(0.55, `rgba(${csR}, ${csG}, ${csB}, 0.03)`);
    bgGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  } else {
    bgGrad.addColorStop(0, `rgba(${cpR}, ${cpG}, ${cpB}, 0.085)`);
    bgGrad.addColorStop(0.52, `rgba(${csR}, ${csG}, ${csB}, 0.04)`);
    bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  }
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  const baseRadius = Math.max(1.25, Math.min(width, height) * 0.0064);

  for (let i = 0; i < OCEAN_PARTICLES.length; i++) {
    const p = OCEAN_PARTICLES[i];
    const ux = p.u + p.jitterU;
    const vy = p.v + p.jitterV;

    let dispX = 0;
    let dispY = 0;
    let waveHeight = 0;

    for (let w = 0; w < OCEAN_OCTAVES.length; w++) {
      const oct = OCEAN_OCTAVES[w];
      const theta = ux * oct.kx + vy * oct.ky - timeSec * oct.speed + p.phaseOffset;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      dispX += cosT * oct.driftX;
      dispY += sinT * oct.driftY;
      waveHeight += sinT * oct.amp;
    }

    const px = (ux + dispX) * width;
    const py = (vy + dispY) * height;
    if (px < -16 || px > width + 16 || py < -16 || py > height + 16) continue;

    const heightNorm = Math.min(1, Math.max(0, (waveHeight + 0.85) / 1.7));
    const [r, g, b] =
      heightNorm < 0.55
        ? mixRgb(palette.trough, palette.mid, heightNorm / 0.55)
        : mixRgb(palette.mid, palette.crest, (heightNorm - 0.55) / 0.45);

    const radius = baseRadius * p.sizeBias * (0.55 + heightNorm * 0.92);
    const alpha = palette.isLight
      ? 0.2 + Math.pow(heightNorm, 1.35) * 0.68
      : 0.16 + Math.pow(heightNorm, 1.4) * 0.78;

    // Soft radial bioluminescent crest bloom
    if (heightNorm > 0.6) {
      const glowRadius = radius * 3.0;
      const glowAlpha = (heightNorm - 0.6) * (palette.isLight ? 0.28 : 0.45);
      const halo = ctx.createRadialGradient(px, py, 0, px, py, glowRadius);
      halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowAlpha.toFixed(3)})`);
      halo.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, ${(glowAlpha * 0.36).toFixed(3)})`);
      halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.beginPath();
      ctx.arc(px, py, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
    ctx.fill();
  }
}

export function parseImageAspectRatio(argsPreview?: string): string {
  if (!argsPreview) return '1 / 1';
  const match = argsPreview.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
  if (!match) return '1 / 1';
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '1 / 1';
  const ratio = w / h;
  if (ratio < 0.4 || ratio > 2.5) return '1 / 1';
  return `${w} / ${h}`;
}

function OceanWaveCanvas({ paused = false }: { paused?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (paused) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // JSDOM logs a noisy notImplemented console.error on getContext('2d')
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
      return;
    }

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    let rafId = 0;
    let width = 340;
    let height = 340;
    const startMs = performance.now();
    let palette = resolveOceanPalette();

    const isReducedMotion = () => {
      const root = document.documentElement;
      const reduceAttr = root.getAttribute('data-reduce-motion') === 'true';
      const reduceMedia =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      return reduceAttr || reduceMedia;
    };

    const syncSize = () => {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, Math.round(rect.width || canvas.parentElement?.clientWidth || 340));
      const cssH = Math.max(1, Math.round(rect.height || canvas.parentElement?.clientHeight || 340));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = cssW;
      height = cssH;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    syncSize();

    const renderFrame = (nowMs: number) => {
      const reduced = isReducedMotion();
      const elapsedSec = reduced ? 1.25 : (nowMs - startMs) / 1000;
      drawOceanFrame(ctx, width, height, elapsedSec, palette);
      if (!reduced) {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    rafId = window.requestAnimationFrame(renderFrame);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        syncSize();
        if (isReducedMotion()) {
          drawOceanFrame(ctx, width, height, 1.25, palette);
        }
      });
      ro.observe(canvas);
    }

    const mo = new MutationObserver(() => {
      palette = resolveOceanPalette();
      cancelAnimationFrame(rafId);
      if (isReducedMotion()) {
        drawOceanFrame(ctx, width, height, 1.25, palette);
      } else {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-preset', 'data-accent', 'data-reduce-motion'],
    });

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      mo.disconnect();
    };
  }, [paused]);

  return <canvas ref={canvasRef} className="gemini-ocean-canvas" aria-hidden="true" />;
}

interface GeneratingImagePlaceholderProps {
  prompt?: string;
  aspectRatio?: string;
  onLayoutChange?: () => void;
}

export function GeneratingImagePlaceholder({
  aspectRatio = '1 / 1',
  onLayoutChange,
}: GeneratingImagePlaceholderProps) {
  useEffect(() => {
    onLayoutChange?.();
  }, [aspectRatio, onLayoutChange]);

  return (
    <div className="chatgpt-image-grid">
      <div
        className="chatgpt-image-card gemini-image-placeholder"
        role="status"
        aria-label="Generating image"
        style={{ aspectRatio }}
      >
        <OceanWaveCanvas />
      </div>
    </div>
  );
}

interface GeneratedImageCardProps {
  image: GeneratedImageRecord;
  onExpand?: (image: GeneratedImageRecord, resolvedSrc: string) => void;
  onSaveToWorkspace?: (image: GeneratedImageRecord) => Promise<void> | void;
  onCopyImage?: (image: GeneratedImageRecord) => Promise<boolean> | boolean | void;
  onReusePrompt?: (prompt: string) => void;
  onLayoutChange?: () => void;
}

export function GeneratedImageCard({
  image,
  onExpand,
  onSaveToWorkspace,
  onCopyImage,
  onReusePrompt,
  onLayoutChange,
}: GeneratedImageCardProps) {
  const [fetchedSrc, setFetchedSrc] = useState<string>('');
  const [loaded, setLoaded] = useState<boolean>(Boolean(image.dataUrl));
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const src = image.dataUrl || fetchedSrc;

  useEffect(() => {
    if (image.dataUrl) return;
    let cancelled = false;
    if (window.smolcode?.readGeneratedImageDataUrl) {
      void window.smolcode
        .readGeneratedImageDataUrl(image.filePath)
        .then((url) => {
          if (!cancelled && url) setFetchedSrc(url);
        })
        .catch(() => {
          // Ignore unreadable historical image
        });
    }
    return () => {
      cancelled = true;
    };
  }, [image.dataUrl, image.filePath]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await onCopyImage?.(image);
    if (ok !== false) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await onSaveToWorkspace?.(image);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const ratio = `${image.width} / ${image.height}`;

  return (
    <div className="chatgpt-image-card">
      <div className="chatgpt-image-actions">
        {onSaveToWorkspace && (
          <button
            type="button"
            className="chatgpt-image-action-btn pressable blur-swap"
            data-active={saved ? 'true' : 'false'}
            onClick={(e) => void handleSave(e)}
            title="Save PNG into workspace"
            aria-label="Save image to workspace"
          >
            {saved ? <Check size={12} aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
            <span>{saved ? 'Saved' : 'Save'}</span>
          </button>
        )}
        {onCopyImage && (
          <button
            type="button"
            className="chatgpt-image-action-btn pressable blur-swap"
            data-active={copied ? 'true' : 'false'}
            onClick={(e) => void handleCopy(e)}
            title="Copy image to clipboard"
            aria-label="Copy image"
          >
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        )}
        {onReusePrompt && (
          <button
            type="button"
            className="chatgpt-image-action-btn pressable"
            onClick={(e) => {
              e.stopPropagation();
              onReusePrompt(image.prompt);
            }}
            title="Iterate on this prompt"
            aria-label="Reuse image prompt"
          >
            <RotateCw size={12} aria-hidden="true" />
          </button>
        )}
        {onExpand && src && (
          <button
            type="button"
            className="chatgpt-image-action-btn pressable"
            onClick={(e) => {
              e.stopPropagation();
              onExpand(image, src);
            }}
            title="Expand preview"
            aria-label="Expand image preview"
          >
            <Maximize2 size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      <button
        type="button"
        className="chatgpt-image-trigger"
        onClick={() => src && onExpand?.(image, src)}
        aria-label={`Inspect generated image: ${image.prompt}`}
        style={{ aspectRatio: ratio, position: 'relative', overflow: 'hidden' }}
      >
        <div
          className="gemini-ocean-backdrop"
          data-visible={!loaded ? 'true' : 'false'}
          aria-hidden="true"
        >
          <OceanWaveCanvas paused={loaded} />
        </div>
        {src && (
          <img
            src={src}
            alt={image.prompt}
            className="chatgpt-image-reveal"
            data-loaded={loaded ? 'true' : 'false'}
            onLoad={() => {
              setLoaded(true);
              onLayoutChange?.();
            }}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              position: 'relative',
              zIndex: 1,
            }}
          />
        )}
      </button>

      <div className="chatgpt-image-caption">
        <span
          className="chatgpt-image-caption-prompt"
          title={image.prompt}
        >
          {image.prompt}
        </span>
        <span className="mono tabular-nums chatgpt-image-caption-meta">
          {image.width}×{image.height} · {image.backend}
        </span>
      </div>
    </div>
  );
}
