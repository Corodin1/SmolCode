import { X } from 'lucide-react';
import type { TelemetrySnapshot, VramStatus } from '../../shared/types';
import { FrostedSurface } from '../Common/FrostedSurface';

interface EfficiencyPopoverProps {
  telemetry: TelemetrySnapshot | null;
  vram: VramStatus;
  onCompactThread?: () => void;
  onClose: () => void;
}

export function EfficiencyPopover({
  telemetry,
  vram,
  onCompactThread,
  onClose,
}: EfficiencyPopoverProps) {
  const totalSaved = telemetry
    ? telemetry.tokensSavedByAst +
      telemetry.tokensSavedByHashline +
      telemetry.tokensSavedByFolding
    : 0;

  return (
    <FrostedSurface
      variant="popover"
      cornerRadius={14}
      className="codex-popover"
      role="dialog"
      aria-label="Context and Inference Telemetry"
      style={{
        position: 'absolute',
        bottom: 36,
        right: 0,
        width: 310,
        padding: 14,
        zIndex: 'var(--z-popover)',
        '--transform-origin': 'bottom right',
      } as React.CSSProperties}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>
          Context & Inference Stats
        </span>
        <button
          type="button"
          className="pressable hover-surface"
          onClick={onClose}
          aria-label="Close context stats"
          style={{
            width: 22,
            height: 22,
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

      {telemetry ? (
        <div
          className="tabular-nums"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Active Context</span>
            <span className="mono">
              {telemetry.activeContextTokens} / {telemetry.contextBudget}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>KV Prefix Cache</span>
            <span className="mono" style={{ color: 'var(--accent-green)' }}>
              {Math.round(telemetry.kvCacheHitRate * 100)}% ({telemetry.kvPrefixTokens} tok)
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Tokens Saved (AST/Hash/Fold)</span>
            <span className="mono">-{totalSaved}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Throughput / TTFT</span>
            <span className="mono">
              {telemetry.evalTokensPerSec} tok/s · {telemetry.promptEvalMs}ms
            </span>
          </div>
        </div>
      ) : (
        <p style={{ margin: '0 0 8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
          Send a prompt to inspect active context usage, KV cache hit rate, and speed.
        </p>
      )}

      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11.5,
          color: 'var(--text-secondary)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>GPU VRAM</span>
          <span className="mono tabular-nums">
            {vram.totalMb > 0
              ? `${vram.freeMb} / ${vram.totalMb} MiB free`
              : 'Probe unavailable'}
          </span>
        </div>
        {onCompactThread && (
          <button
            type="button"
            className="pressable hover-surface"
            onClick={() => {
              onCompactThread();
              onClose();
            }}
            style={{
              height: 28,
              borderRadius: 7,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-surface)',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text-primary)',
            }}
          >
            Compact thread context (/compact)
          </button>
        )}
      </div>
    </FrostedSurface>
  );
}
