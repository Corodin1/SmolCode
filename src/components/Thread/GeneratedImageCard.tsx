import { Check, Copy, Download, Maximize2, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GeneratedImageRecord } from '../../shared/types';

interface GeneratingImagePlaceholderProps {
  prompt?: string;
}

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

const OCEAN_COLS = 22;
const OCEAN_ROWS = 20;

// Four directional Gerstner-style wave octaves producing rolling swells and cross-currents
const OCEAN_OCTAVES: readonly OceanWaveOctave[] = [
  { kx: 4.6, ky: 1.9, speed: 1.35, amp: 0.44, driftX: 0.02, driftY: 0.015 },
  { kx: -2.9, ky: 4.4, speed: 1.75, amp: 0.28, driftX: -0.013, driftY: 0.017 },
  { kx: 7.8, ky: -3.8, speed: 2.25, amp: 0.17, driftX: 0.008, driftY: -0.01 },
  { kx: 1.9, ky: 8.6, speed: 1.1, amp: 0.11, driftX: 0.005, driftY: 0.011 },
];

// Deterministic pseudo-random helper so particles sit organically without Math.random() drift
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
    // Slight overscan (-0.06..1.06) keeps edges lush as waves oscillate horizontally/vertically
    const u = -0.05 + ((col + rowShift) / (OCEAN_COLS - 0.5)) * 1.1;
    const v = -0.05 + (row / (OCEAN_ROWS - 1)) * 1.1;
    return {
      u,
      v,
      jitterU: (hash01(i * 3 + 1) - 0.5) * 0.032,
      jitterV: (hash01(i * 3 + 2) - 0.5) * 0.032,
      phaseOffset: hash01(i * 3 + 3) * 0.45,
      sizeBias: 0.8 + hash01(i * 7 + 5) * 0.45,
    };
  },
);

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sampleOceanColor(heightNorm: number, isLight: boolean): [number, number, number] {
  // Deep ocean cobalt -> luminous cyan-blue -> crest indigo-violet
  const t = Math.min(1, Math.max(0, heightNorm));
  if (isLight) {
    if (t < 0.5) {
      const k = t * 2;
      return [Math.round(lerp(59, 37, k)), Math.round(lerp(130, 99, k)), Math.round(lerp(246, 235, k))];
    }
    const k = (t - 0.5) * 2;
    return [Math.round(lerp(37, 124, k)), Math.round(lerp(99, 58, k)), Math.round(lerp(235, 237, k))];
  }
  if (t < 0.45) {
    const k = t / 0.45;
    return [Math.round(lerp(37, 56, k)), Math.round(lerp(99, 189, k)), Math.round(lerp(235, 248, k))];
  }
  if (t < 0.78) {
    const k = (t - 0.45) / 0.33;
    return [Math.round(lerp(56, 129, k)), Math.round(lerp(189, 140, k)), Math.round(lerp(248, 248, k))];
  }
  const k = (t - 0.78) / 0.22;
  return [Math.round(lerp(129, 196, k)), Math.round(lerp(140, 181, k)), Math.round(lerp(248, 253, k))];
}

function drawOceanFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeSec: number,
  isLight: boolean,
) {
  ctx.clearRect(0, 0, width, height);

  // Subtle flowing deep-sea caustic gradient moving with the dominant swell
  const swellShiftX = Math.sin(timeSec * 0.45) * width * 0.12;
  const swellShiftY = Math.cos(timeSec * 0.38) * height * 0.1;
  const bgGrad = ctx.createRadialGradient(
    width * 0.5 + swellShiftX,
    height * 0.48 + swellShiftY,
    width * 0.05,
    width * 0.5,
    height * 0.5,
    width * 0.78,
  );
  if (isLight) {
    bgGrad.addColorStop(0, 'rgba(99, 102, 241, 0.12)');
    bgGrad.addColorStop(0.55, 'rgba(56, 189, 248, 0.06)');
    bgGrad.addColorStop(1, 'rgba(245, 247, 252, 0)');
  } else {
    bgGrad.addColorStop(0, 'rgba(56, 189, 248, 0.13)');
    bgGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.08)');
    bgGrad.addColorStop(1, 'rgba(14, 14, 18, 0)');
  }
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  const baseRadius = Math.max(1.3, Math.min(width, height) * 0.0066);

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
      // Gerstner orbital displacement causes dots to compress on crests and spread in troughs
      dispX += cosT * oct.driftX;
      dispY += sinT * oct.driftY;
      waveHeight += sinT * oct.amp;
    }

    const px = (ux + dispX) * width;
    const py = (vy + dispY) * height;
    if (px < -16 || px > width + 16 || py < -16 || py > height + 16) continue;

    // Normalize waveHeight roughly from [-1, 1] -> [0, 1]
    const heightNorm = Math.min(1, Math.max(0, (waveHeight + 0.85) / 1.7));
    const [r, g, b] = sampleOceanColor(heightNorm, isLight);

    const radius = baseRadius * p.sizeBias * (0.55 + heightNorm * 0.95);
    const alpha = isLight
      ? 0.22 + Math.pow(heightNorm, 1.35) * 0.72
      : 0.18 + Math.pow(heightNorm, 1.4) * 0.8;

    // Soft radial bioluminescent crest bloom (no hard ring edges)
    if (heightNorm > 0.58) {
      const glowRadius = radius * 3.1;
      const glowAlpha = (heightNorm - 0.58) * (isLight ? 0.34 : 0.52);
      const halo = ctx.createRadialGradient(px, py, 0, px, py, glowRadius);
      halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowAlpha.toFixed(3)})`);
      halo.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, ${(glowAlpha * 0.38).toFixed(3)})`);
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

export function GeneratingImagePlaceholder(_props: GeneratingImagePlaceholderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
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

    const readThemeAndMotion = () => {
      const root = document.documentElement;
      const isLight = root.getAttribute('data-theme') === 'light';
      const reduceAttr = root.getAttribute('data-reduce-motion') === 'true';
      const reduceMedia =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      return { isLight, reducedMotion: reduceAttr || reduceMedia };
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
      const { isLight, reducedMotion } = readThemeAndMotion();
      const elapsedSec = reducedMotion ? 1.25 : (nowMs - startMs) / 1000;
      drawOceanFrame(ctx, width, height, elapsedSec, isLight);
      if (!reducedMotion) {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    rafId = window.requestAnimationFrame(renderFrame);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        syncSize();
        const { isLight, reducedMotion } = readThemeAndMotion();
        if (reducedMotion) {
          drawOceanFrame(ctx, width, height, 1.25, isLight);
        }
      });
      ro.observe(canvas);
    }

    const mo = new MutationObserver(() => {
      const { isLight, reducedMotion } = readThemeAndMotion();
      cancelAnimationFrame(rafId);
      if (reducedMotion) {
        drawOceanFrame(ctx, width, height, 1.25, isLight);
      } else {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-reduce-motion'],
    });

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <div className="chatgpt-image-grid">
      <div
        className="chatgpt-image-card gemini-image-placeholder"
        role="status"
        aria-label="Generating image"
        style={{ aspectRatio: '1 / 1' }}
      >
        <canvas ref={canvasRef} className="gemini-ocean-canvas" aria-hidden="true" />
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
            className="chatgpt-image-action-btn pressable"
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
            className="chatgpt-image-action-btn pressable"
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
        {!loaded && (
          <div
            className="chatgpt-image-skeleton-wash"
            style={{ position: 'absolute', inset: 0 }}
            aria-hidden="true"
          />
        )}
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
            }}
          />
        )}
      </button>

      <div className="chatgpt-image-caption">
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={image.prompt}
        >
          {image.prompt}
        </span>
        <span className="mono tabular-nums" style={{ fontSize: 10.5, flexShrink: 0 }}>
          {image.width}×{image.height} · {image.backend}
        </span>
      </div>
    </div>
  );
}
