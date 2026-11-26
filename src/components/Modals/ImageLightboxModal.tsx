import { Check, Copy, Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GeneratedImageRecord } from '../../shared/types';
import { FrostedSurface } from '../Common/FrostedSurface';

interface ImageLightboxModalProps {
  image: GeneratedImageRecord;
  src: string;
  onSaveToWorkspace?: (image: GeneratedImageRecord) => Promise<void> | void;
  onCopyImage?: (image: GeneratedImageRecord) => Promise<boolean> | boolean | void;
  onClose: () => void;
}

export function ImageLightboxModal({
  image,
  src,
  onSaveToWorkspace,
  onCopyImage,
  onClose,
}: ImageLightboxModalProps) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="codex-modal-backdrop glass-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Generated image preview"
      onClick={onClose}
    >
      <FrostedSurface
        variant="modal"
        cornerRadius={16}
        className="codex-modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(920px, 92vw)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={image.prompt}
          >
            {image.prompt}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {onSaveToWorkspace && (
              <button
                type="button"
                className="codex-pill pressable hover-surface"
                onClick={() => {
                  void onSaveToWorkspace(image);
                  setSaved(true);
                  setTimeout(() => setSaved(false), 1800);
                }}
              >
                {saved ? <Check size={12} aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
                <span>{saved ? 'Saved' : 'Save to workspace'}</span>
              </button>
            )}
            {onCopyImage && (
              <button
                type="button"
                className="codex-pill pressable hover-surface"
                onClick={async () => {
                  const ok = await onCopyImage(image);
                  if (ok !== false) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  }
                }}
              >
                {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
            <button
              type="button"
              className="pressable hover-surface"
              onClick={onClose}
              aria-label="Close image preview"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-sidebar)',
          }}
        >
          <img
            src={src}
            alt={image.prompt}
            style={{
              maxWidth: '100%',
              maxHeight: '68vh',
              borderRadius: 12,
              objectFit: 'contain',
              boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
            }}
          />
        </div>

        <div
          className="mono tabular-nums"
          style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: 11.5,
            color: 'var(--text-muted)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 14,
          }}
        >
          <span>{image.width}×{image.height}</span>
          <span>Backend: {image.backend}</span>
          <span>Model: {image.model}</span>
          <span>Steps: {image.steps}</span>
          <span>Seed: {image.seed}</span>
          <span>{(image.durationMs / 1000).toFixed(1)}s</span>
        </div>
      </FrostedSurface>
    </div>
  );
}
