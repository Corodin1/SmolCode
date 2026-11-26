import {
  ArrowUp,
  Check,
  ChevronDown,
  Cpu,
  FilePlus2,
  ImagePlus,
  ListChecks,
  Mic,
  MicOff,
  Plus,
  Shield,
  Sparkles,
  Square,
  Wand2,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  ApprovalPolicy,
  ImageGenSize,
  OllamaModelInfo,
  TelemetrySnapshot,
  ThreadRecord,
  VramStatus,
} from '../../shared/types';
import { FrostedSurface } from '../Common/FrostedSurface';
import { Tooltip } from '../Common/Tooltip';
import { EfficiencyPopover } from '../Thread/EfficiencyPopover';
import { EFFORT_TIERS, EffortSignalIcon, EffortSlider } from './EffortSlider';

interface ComposerBarProps {
  thread: ThreadRecord;
  models: OllamaModelInfo[];
  vram: VramStatus;
  latestTelemetry: TelemetrySnapshot | null;
  showAdvancedDualModel: boolean;
  pinFastToCpu: boolean;
  activeContextTokens: number;
  contextBudget: number;
  isBusy: boolean;
  canSend: boolean;
  followUpMode: 'queue' | 'steer';
  recording: boolean;
  transcribing: boolean;
  statsOpen?: boolean;
  imageGenSize?: ImageGenSize;
  onChangeImageGenSize?: (size: ImageGenSize) => void;
  onSetStatsOpen?: (open: boolean) => void;
  onToggleFollowUpMode: () => void;
  onToggleRecording: () => void;
  onAttachFiles: () => void;
  onOpenSkills: () => void;
  onCompactThread: () => void;
  onUpdateThread: (patch: Partial<ThreadRecord>) => void;
  onSend: () => void;
  onStop: () => void;
}

const IMAGE_SIZE_OPTIONS: Array<{ value: ImageGenSize; shortLabel: string; label: string }> = [
  { value: '1024x1024', shortLabel: '1:1', label: 'Square (1024×1024)' },
  { value: '1024x576', shortLabel: '16:9', label: 'Landscape (1024×576)' },
  { value: '576x1024', shortLabel: '9:16', label: 'Portrait (576×1024)' },
  { value: '768x768', shortLabel: '768px', label: 'Balanced (768×768)' },
  { value: '512x512', shortLabel: '512px', label: 'Fast draft (512×512)' },
];

const APPROVAL_OPTIONS: Array<{ value: ApprovalPolicy; label: string; hint: string }> = [
  { value: 'read-only', label: 'Read-only', hint: 'No edits or shell mutations' },
  { value: 'auto', label: 'Auto', hint: 'Edits & safe checks auto, ask shell' },
  { value: 'full-access', label: 'Full Access', hint: 'Run commands without prompts' },
];

type OpenMenu =
  | 'attach'
  | 'main'
  | 'fast'
  | 'effort'
  | 'imageSize'
  | 'approval'
  | 'stats'
  | null;

function shortModelName(name: string): string {
  if (!name) return 'Select model';
  const noRepo = name.includes('/') ? name.split('/').pop() ?? name : name;
  return noRepo.replace(/:latest$/, '');
}

export function ComposerBar({
  thread,
  models,
  vram,
  latestTelemetry,
  showAdvancedDualModel,
  pinFastToCpu,
  activeContextTokens,
  contextBudget,
  isBusy,
  canSend,
  followUpMode,
  recording,
  transcribing,
  statsOpen,
  imageGenSize = '1024x1024',
  onChangeImageGenSize,
  onSetStatsOpen,
  onToggleFollowUpMode,
  onToggleRecording,
  onAttachFiles,
  onOpenSkills,
  onCompactThread,
  onUpdateThread,
  onSend,
  onStop,
}: ComposerBarProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const isStatsOpen = statsOpen ?? openMenu === 'stats';
  const hasImageGenChip = (thread.draftChips ?? []).some(
    (c) => c.kind === 'skill' && (c.skillName ?? c.label).replace(/^\/+/, '') === 'image-gen',
  );
  const imageSizeMeta =
    IMAGE_SIZE_OPTIONS.find((s) => s.value === imageGenSize) ?? IMAGE_SIZE_OPTIONS[0];

  const toggleImageGenSkill = () => {
    const existing = thread.draftChips ?? [];
    if (hasImageGenChip) {
      onUpdateThread({
        draftChips: existing.filter(
          (c) => !(c.kind === 'skill' && (c.skillName ?? c.label).replace(/^\/+/, '') === 'image-gen'),
        ),
      });
    } else {
      onUpdateThread({
        ...(thread.interactionMode === 'plan' ? { interactionMode: 'build' } : {}),
        draftChips: [
          ...existing,
          {
            id: 'skill:image-gen',
            kind: 'skill',
            label: '/image-gen',
            skillName: 'image-gen',
          },
        ],
      });
    }
    setOpenMenu(null);
  };

  useEffect(() => {
    if (!openMenu && !statsOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        onSetStatsOpen?.(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        onSetStatsOpen?.(false);
      }
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu, statsOpen, onSetStatsOpen]);

  const toggleMenu = (menu: OpenMenu) => {
    if (menu === 'stats' && onSetStatsOpen) {
      onSetStatsOpen(!isStatsOpen);
      setOpenMenu(null);
      return;
    }
    onSetStatsOpen?.(false);
    setOpenMenu((prev) => (prev === menu ? null : menu));
  };

  const ctxRatio = Math.min(1, activeContextTokens / Math.max(1, contextBudget));
  const effortMeta = EFFORT_TIERS.find((e) => e.value === thread.effort) ?? EFFORT_TIERS[1];
  const approvalMeta =
    APPROVAL_OPTIONS.find((a) => a.value === thread.approvalPolicy) ?? APPROVAL_OPTIONS[1];

  return (
    <div
      ref={barRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        padding: '6px 10px 9px',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
        {/* + Attachment & Mode Menu */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={() => toggleMenu('attach')}
            aria-expanded={openMenu === 'attach'}
            aria-label="Attach files, images, or skills"
            title="Attach & tools"
            style={{
              width: 27,
              height: 27,
              borderRadius: '50%',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Plus size={14} aria-hidden="true" />
          </button>

          {openMenu === 'attach' && (
            <FrostedSurface
              variant="popover"
              cornerRadius={11}
              className="codex-popover"
              role="menu"
              style={{
                position: 'absolute',
                bottom: 34,
                left: 0,
                width: 215,
                padding: 5,
                zIndex: 'var(--z-popover)',
                '--transform-origin': 'bottom left',
              } as React.CSSProperties}
            >
              <button
                type="button"
                role="menuitem"
                className="pressable hover-surface"
                onClick={() => {
                  setOpenMenu(null);
                  onAttachFiles();
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  border: 'none',
                  borderRadius: 7,
                  background: 'transparent',
                  fontSize: 12.5,
                  textAlign: 'left',
                }}
              >
                <FilePlus2 size={13} aria-hidden="true" />
                <span>Attach files or images</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="pressable hover-surface"
                onClick={toggleImageGenSkill}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '6px 8px',
                  border: 'none',
                  borderRadius: 7,
                  background: hasImageGenChip ? 'var(--accent-brand-soft)' : 'transparent',
                  color: hasImageGenChip ? 'var(--accent-brand)' : 'inherit',
                  fontSize: 12.5,
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Wand2 size={13} aria-hidden="true" />
                  <span>Create image</span>
                </span>
                {hasImageGenChip && <Check size={12} aria-hidden="true" />}
              </button>
              <button
                type="button"
                role="menuitem"
                className="pressable hover-surface"
                onClick={() => {
                  setOpenMenu(null);
                  onOpenSkills();
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  border: 'none',
                  borderRadius: 7,
                  background: 'transparent',
                  fontSize: 12.5,
                  textAlign: 'left',
                }}
              >
                <Sparkles size={13} aria-hidden="true" />
                <span>Browse skills</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="pressable hover-surface"
                onClick={() => {
                  onUpdateThread({
                    interactionMode: thread.interactionMode === 'plan' ? 'build' : 'plan',
                  });
                  setOpenMenu(null);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  border: 'none',
                  borderRadius: 7,
                  background: 'transparent',
                  fontSize: 12.5,
                  textAlign: 'left',
                }}
              >
                <ListChecks size={13} aria-hidden="true" />
                <span>
                  {thread.interactionMode === 'plan' ? 'Switch to Build mode' : 'Switch to Plan mode'}
                </span>
              </button>
              <div
                style={{
                  padding: '4px 8px 2px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <ImagePlus size={11} aria-hidden="true" />
                <span>Tip: paste screenshots directly</span>
              </div>
            </FrostedSurface>
          )}
        </div>

        {/* Plan / Build Mode Pill */}
        <button
          type="button"
          className="codex-pill pressable hover-surface"
          data-highlighted={thread.interactionMode === 'plan'}
          onClick={() =>
            onUpdateThread({
              interactionMode: thread.interactionMode === 'plan' ? 'build' : 'plan',
            })
          }
          title="Toggle Build / Plan mode (Shift+Tab)"
          style={{
            borderColor:
              thread.interactionMode === 'plan' ? 'var(--accent-blue)' : 'var(--border-subtle)',
            background:
              thread.interactionMode === 'plan' ? 'var(--accent-blue-soft)' : 'var(--bg-surface)',
            color:
              thread.interactionMode === 'plan' ? 'var(--accent-blue)' : 'var(--text-secondary)',
          }}
        >
          <ListChecks size={12} aria-hidden="true" />
          <span className="codex-pill-label">
            {thread.interactionMode === 'plan' ? 'Plan' : 'Build'}
          </span>
        </button>

        {/* Primary Model Picker */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="codex-pill pressable hover-surface"
            onClick={() => toggleMenu('main')}
            aria-expanded={openMenu === 'main'}
            title={`Model: ${thread.mainModel || 'Not selected'}`}
          >
            <Cpu size={12} aria-hidden="true" />
            <span className="codex-pill-label">{shortModelName(thread.mainModel)}</span>
            <ChevronDown size={11} aria-hidden="true" />
          </button>

          {openMenu === 'main' && (
            <FrostedSurface
              variant="popover"
              cornerRadius={11}
              className="codex-popover"
              role="menu"
              aria-label="Select Model"
              style={{
                position: 'absolute',
                bottom: 34,
                left: 0,
                width: 295,
                zIndex: 'var(--z-popover)',
                '--transform-origin': 'bottom left',
              } as React.CSSProperties}
            >
              <div style={{ maxHeight: 260, overflowY: 'auto', padding: 6 }}>
              <div style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                Model
              </div>
              {models.length === 0 ? (
                <div style={{ padding: '8px', fontSize: 12, color: 'var(--text-muted)' }}>
                  No local models detected. Check Settings → Models.
                </div>
              ) : (
                models.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    role="menuitemradio"
                    aria-checked={m.name === thread.mainModel}
                    className="pressable hover-surface"
                    onClick={() => {
                      onUpdateThread({
                        mainModel: m.name,
                        ...(showAdvancedDualModel ? {} : { fastModel: m.name }),
                      });
                      setOpenMenu(null);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      border: 'none',
                      borderRadius: 7,
                      background: 'transparent',
                      textAlign: 'left',
                      fontSize: 12,
                    }}
                  >
                    <Check
                      size={12}
                      style={{
                        opacity: m.name === thread.mainModel ? 1 : 0,
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {shortModelName(m.name)}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {m.parameterSize}
                    </span>
                  </button>
                ))
              )}
              </div>
            </FrostedSurface>
          )}
        </div>

        {/* Reasoning Effort Pill + Tactile Pill Slider Popover */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="codex-pill pressable hover-surface"
            data-effort={thread.effort}
            onClick={() => toggleMenu('effort')}
            aria-expanded={openMenu === 'effort'}
            title={`Reasoning Effort: ${effortMeta.label}`}
            style={
              thread.effort === 'xhigh'
                ? {
                    borderColor: 'color-mix(in srgb, var(--effort-xhigh) 42%, var(--border-subtle))',
                    background: 'color-mix(in srgb, var(--effort-xhigh) 12%, var(--bg-surface))',
                  }
                : undefined
            }
          >
            <EffortSignalIcon level={thread.effort} size={12} />
            <span
              className="codex-pill-label"
              style={
                thread.effort === 'xhigh'
                  ? { color: 'var(--effort-xhigh)', fontWeight: 600 }
                  : undefined
              }
            >
              {effortMeta.label}
            </span>
            <ChevronDown size={11} aria-hidden="true" />
          </button>

          {openMenu === 'effort' && (
            <FrostedSurface
              variant="popover"
              cornerRadius={18}
              className="codex-popover"
              role="dialog"
              aria-label="Reasoning Effort Slider"
              style={{
                position: 'absolute',
                bottom: 34,
                left: 0,
                width: 284,
                padding: '12px 14px 14px',
                zIndex: 'var(--z-popover)',
                '--transform-origin': 'bottom left',
              } as React.CSSProperties}
            >
              <EffortSlider
                variant="popover"
                value={thread.effort}
                onChange={(nextEffort) => onUpdateThread({ effort: nextEffort })}
              />
            </FrostedSurface>
          )}
        </div>

        {/* Inline Image Aspect Ratio Pill (shown when Create image / /image-gen is active) */}
        {hasImageGenChip && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="codex-pill pressable hover-surface"
              data-highlighted="true"
              onClick={() => toggleMenu('imageSize')}
              aria-expanded={openMenu === 'imageSize'}
              title={`Image size: ${imageSizeMeta.label}`}
            >
              <Wand2 size={11.5} style={{ color: 'var(--accent-brand)' }} aria-hidden="true" />
              <span className="codex-pill-label">{imageSizeMeta.shortLabel}</span>
              <ChevronDown size={11} aria-hidden="true" />
            </button>

            {openMenu === 'imageSize' && (
              <FrostedSurface
                variant="popover"
                cornerRadius={11}
                className="codex-popover"
                role="menu"
                aria-label="Select Image Size"
                style={{
                  position: 'absolute',
                  bottom: 34,
                  left: 0,
                  width: 215,
                  padding: 5,
                  zIndex: 'var(--z-popover)',
                  '--transform-origin': 'bottom left',
                } as React.CSSProperties}
              >
                <div style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                  Image Aspect Ratio
                </div>
                {IMAGE_SIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={opt.value === imageGenSize}
                    className="pressable hover-surface"
                    onClick={() => {
                      onChangeImageGenSize?.(opt.value);
                      setOpenMenu(null);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      border: 'none',
                      borderRadius: 7,
                      background: 'transparent',
                      textAlign: 'left',
                      fontSize: 12,
                    }}
                  >
                    <Check
                      size={12}
                      style={{ opacity: opt.value === imageGenSize ? 1 : 0, flexShrink: 0 }}
                      aria-hidden="true"
                    />
                    <span>{opt.label}</span>
                  </button>
                ))}
              </FrostedSurface>
            )}
          </div>
        )}

        {/* Optional Dual-Model Fast Scout Pill (only shown when enabled in Settings) */}
        {showAdvancedDualModel && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="codex-pill pressable hover-surface codex-hide-mini"
              onClick={() => toggleMenu('fast')}
              aria-expanded={openMenu === 'fast'}
              title={`Fast Scout Model: ${thread.fastModel}${pinFastToCpu ? ' [CPU]' : ''}`}
            >
              <Zap size={12} style={{ color: 'var(--accent-amber)' }} aria-hidden="true" />
              <span className="codex-pill-label">{shortModelName(thread.fastModel)}</span>
              <ChevronDown size={11} aria-hidden="true" />
            </button>

            {openMenu === 'fast' && (
              <FrostedSurface
                variant="popover"
                cornerRadius={13}
                className="codex-popover"
                role="menu"
                aria-label="Select Fast Scout Model"
                style={{
                  position: 'absolute',
                  bottom: 34,
                  left: 0,
                  width: 280,
                  zIndex: 'var(--z-popover)',
                  '--transform-origin': 'bottom left',
                } as React.CSSProperties}
              >
                <div style={{ maxHeight: 260, overflowY: 'auto', padding: 6 }}>
                <div style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                  Fast Scout Model
                </div>
                {models.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    role="menuitemradio"
                    aria-checked={m.name === thread.fastModel}
                    className="pressable hover-surface"
                    onClick={() => {
                      onUpdateThread({ fastModel: m.name });
                      setOpenMenu(null);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      border: 'none',
                      borderRadius: 7,
                      background: 'transparent',
                      textAlign: 'left',
                      fontSize: 12,
                    }}
                  >
                    <Check
                      size={12}
                      style={{ opacity: m.name === thread.fastModel ? 1 : 0, flexShrink: 0 }}
                      aria-hidden="true"
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortModelName(m.name)}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {m.parameterSize}
                    </span>
                  </button>
                ))}
                </div>
              </FrostedSurface>
            )}
          </div>
        )}

        {/* Approval / Permissions Pill */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="codex-pill pressable hover-surface codex-hide-mini"
            onClick={() => toggleMenu('approval')}
            aria-expanded={openMenu === 'approval'}
            title={`Permissions: ${approvalMeta.label}`}
          >
            <Shield size={12} aria-hidden="true" />
            <span className="codex-pill-label">{approvalMeta.label}</span>
          </button>

          {openMenu === 'approval' && (
            <FrostedSurface
              variant="popover"
              cornerRadius={11}
              className="codex-popover"
              role="menu"
              aria-label="Permissions Policy"
              style={{
                position: 'absolute',
                bottom: 34,
                left: 0,
                width: 245,
                padding: 6,
                zIndex: 'var(--z-popover)',
                '--transform-origin': 'bottom left',
              } as React.CSSProperties}
            >
              {APPROVAL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={thread.approvalPolicy === opt.value}
                  className="pressable hover-surface"
                  onClick={() => {
                    onUpdateThread({ approvalPolicy: opt.value });
                    setOpenMenu(null);
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    border: 'none',
                    borderRadius: 7,
                    background: 'transparent',
                    textAlign: 'left',
                  }}
                >
                  <Check
                    size={12}
                    style={{
                      opacity: thread.approvalPolicy === opt.value ? 1 : 0,
                      flexShrink: 0,
                    }}
                    aria-hidden="true"
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>{opt.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{opt.hint}</span>
                  </div>
                </button>
              ))}
            </FrostedSurface>
          )}
        </div>
      </div>

      {/* Right Controls: Context Ring + Mic + Queue/Steer + Stop/Send */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, position: 'relative' }}>
        <Tooltip label={`Context: ${activeContextTokens} / ${contextBudget} tokens`} placement="top">
          <button
            type="button"
            className="pressable hover-surface"
            onClick={() => toggleMenu('stats')}
            aria-label="Inspect context window usage"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 26,
              padding: '0 7px',
              borderRadius: 999,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 11,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="9" r="7" fill="none" stroke="var(--border-default)" strokeWidth="2" />
              <circle
                cx="9"
                cy="9"
                r="7"
                fill="none"
                stroke={ctxRatio > 0.85 ? 'var(--accent-amber)' : 'var(--text-secondary)'}
                strokeWidth="2"
                strokeDasharray={`${Math.round(ctxRatio * 44)} 44`}
                transform="rotate(-90 9 9)"
              />
            </svg>
            <span className="mono tabular-nums">{Math.round(activeContextTokens / 100) / 10}k</span>
          </button>
        </Tooltip>

        {isStatsOpen && (
          <EfficiencyPopover
            telemetry={latestTelemetry}
            vram={vram}
            onCompactThread={onCompactThread}
            onClose={() => {
              setOpenMenu(null);
              onSetStatsOpen?.(false);
            }}
          />
        )}

        <Tooltip
          label={
            transcribing
              ? 'Transcribing...'
              : recording
                ? 'Stop recording'
                : 'Dictate prompt'
          }
          placement="top"
        >
          <button
            type="button"
            className="pressable hover-surface codex-mic-btn"
            data-recording={recording}
            onClick={onToggleRecording}
            disabled={transcribing}
            aria-label={recording ? 'Stop dictation' : 'Voice dictation'}
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              border: recording ? '1px solid var(--accent-red)' : '1px solid transparent',
              background: recording ? 'var(--accent-red-soft)' : 'transparent',
              color: recording ? 'var(--accent-red)' : 'var(--text-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {recording ? <MicOff size={13.5} aria-hidden="true" /> : <Mic size={13.5} aria-hidden="true" />}
          </button>
        </Tooltip>

        {isBusy && (
          <button
            type="button"
            className="codex-pill pressable hover-surface"
            data-highlighted="true"
            onClick={onToggleFollowUpMode}
            title="Choose whether Enter queues next turn or steers active run"
            style={{ height: 26, fontSize: 11 }}
          >
            {followUpMode === 'queue' ? 'Queue' : 'Steer'}
          </button>
        )}

        {isBusy && !canSend ? (
          <button
            type="button"
            className="pressable blur-swap codex-primary-btn"
            onClick={onStop}
            aria-label="Stop current turn"
            title="Stop"
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              border: 'none',
              background: 'var(--accent-primary)',
              color: 'var(--accent-primary-fg)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Square size={12} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {isBusy && (
              <button
                type="button"
                className="pressable hover-surface"
                onClick={onStop}
                aria-label="Stop agent"
                title="Stop"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Square size={11} fill="currentColor" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="pressable blur-swap codex-primary-btn"
              disabled={!canSend}
              onClick={onSend}
              aria-label={
                isBusy
                  ? followUpMode === 'queue'
                    ? 'Queue follow-up prompt'
                    : 'Steer running thread'
                  : 'Send message'
              }
              title={
                isBusy
                  ? followUpMode === 'queue'
                    ? 'Add to queue (Enter)'
                    : 'Steer next step (Enter)'
                  : 'Send (Enter)'
              }
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                border: 'none',
                background: 'var(--accent-primary)',
                color: 'var(--accent-primary-fg)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
