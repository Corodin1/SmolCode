import {
  Clock,
  Code2,
  FileCode2,
  Image as ImageIcon,
  MessageSquare,
  Sparkles,
  Terminal,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceDictation } from '../../hooks/useVoiceDictation';
import type {
  ComposerChip,
  ImageGenSize,
  OllamaModelInfo,
  SearchSuggestion,
  SkillEntry,
  TelemetrySnapshot,
  ThreadRecord,
  VramStatus,
} from '../../shared/types';
import { FrostedSurface } from '../Common/FrostedSurface';
import { ComposerBar } from './ComposerBar';
import { BUILTIN_SLASH_COMMANDS, SlashMenu, type SlashItem } from './SlashMenu';

interface ComposerProps {
  dockRef?: React.RefObject<HTMLDivElement | null>;
  thread: ThreadRecord;
  models: OllamaModelInfo[];
  skills: SkillEntry[];
  vram: VramStatus;
  latestTelemetry: TelemetrySnapshot | null;
  showAdvancedDualModel: boolean;
  pinFastToCpu: boolean;
  activeContextTokens: number;
  contextBudget: number;
  imageGenSize?: ImageGenSize;
  onChangeImageGenSize?: (size: ImageGenSize) => void;
  onUpdateThread: (patch: Partial<ThreadRecord>) => void;
  onSendPrompt: (content: string, chips: ComposerChip[]) => void;
  onSteerThread: (content: string, chips: ComposerChip[]) => void;
  onEnqueuePrompt: (content: string, chips: ComposerChip[]) => void;
  onRemoveQueuedPrompt: (queueId: string) => void;
  onStopThread: () => void;
  onSlashAction: (cmdName: string) => void;
  onAttachFiles: () => void;
  onOpenSkills: () => void;
}

export function Composer({
  dockRef,
  thread,
  models,
  skills,
  vram,
  latestTelemetry,
  showAdvancedDualModel,
  pinFastToCpu,
  activeContextTokens,
  contextBudget,
  imageGenSize,
  onChangeImageGenSize,
  onUpdateThread,
  onSendPrompt,
  onSteerThread,
  onEnqueuePrompt,
  onRemoveQueuedPrompt,
  onStopThread,
  onSlashAction,
  onAttachFiles,
  onOpenSkills,
}: ComposerProps) {
  const [text, setText] = useState(thread.draftText ?? '');
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [followUpMode, setFollowUpMode] = useState<'queue' | 'steer'>('queue');
  const [statsOpen, setStatsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chips = thread.draftChips ?? [];
  const queued = thread.queuedPrompts ?? [];

  useEffect(() => {
    const timer = setTimeout(() => {
      if (text !== thread.draftText) {
        onUpdateThread({ draftText: text });
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [text, thread.draftText, onUpdateThread]);

  const voice = useVoiceDictation((transcript) => {
    setText((prev) => (prev ? `${prev.trimEnd()} ${transcript}` : transcript));
    textareaRef.current?.focus();
  });

  const isBusy =
    thread.status === 'scouting' ||
    thread.status === 'thinking' ||
    thread.status === 'verifying' ||
    thread.status === 'queued' ||
    thread.status === 'awaiting_input';

  const slashItems: SlashItem[] = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    const cmds: SlashItem[] = BUILTIN_SLASH_COMMANDS.filter(
      (c) => c.name.includes(q) || c.description.toLowerCase().includes(q),
    ).map((cmd) => ({ kind: 'command', cmd }));
    const skillItems: SlashItem[] = skills
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((skill) => ({ kind: 'skill', skill }));
    return [...cmds, ...skillItems];
  }, [slashQuery, skills]);

  const handleTextChange = async (next: string) => {
    setText(next);

    const atMatch = next.match(/(?:^|\s)@([A-Za-z0-9_./\\-]*)$/);
    if (atMatch && window.smolcode) {
      setSlashQuery(null);
      const res = await window.smolcode.searchSymbolsAndFiles(
        thread.projectId,
        atMatch[1],
      );
      setSuggestions(res);
      setSelectedIdx(0);
      return;
    }

    const slashMatch = next.match(/^\/([A-Za-z0-9_-]*)$/);
    if (slashMatch) {
      setSuggestions([]);
      setSlashQuery(slashMatch[1]);
      setSelectedIdx(0);
      return;
    }

    setSuggestions([]);
    setSlashQuery(null);
  };

  const applySuggestion = (s: SearchSuggestion) => {
    const chip: ComposerChip = {
      id: `${s.kind}:${s.filePath}:${s.symbolName ?? ''}`,
      kind: s.kind,
      label: s.symbolName ? `${s.filePath}::${s.symbolName}` : s.filePath,
      filePath: s.filePath,
      symbolName: s.symbolName,
      startLine: s.startLine,
      endLine: s.endLine,
    };
    if (!chips.some((c) => c.id === chip.id)) {
      onUpdateThread({ draftChips: [...chips, chip] });
    }
    setText((prev) => prev.replace(/(?:^|\s)@[A-Za-z0-9_./\\-]*$/, ' ').trimStart());
    setSuggestions([]);
    textareaRef.current?.focus();
  };

  const applySlashItem = (item: SlashItem) => {
    setSlashQuery(null);
    if (item.kind === 'skill') {
      const chip: ComposerChip = {
        id: `skill:${item.skill.name}`,
        kind: 'skill',
        label: `/${item.skill.name}`,
        skillName: item.skill.name,
      };
      if (!chips.some((c) => c.id === chip.id)) {
        onUpdateThread({ draftChips: [...chips, chip], draftText: '' });
      }
      setText('');
      textareaRef.current?.focus();
      return;
    }
    setText('');
    onUpdateThread({ draftText: '' });
    if (item.cmd.name === 'status') {
      setStatsOpen(true);
      return;
    }
    onSlashAction(item.cmd.name);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? '');
          const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          onUpdateThread({
            draftChips: [
              ...chips,
              {
                id: `img:${Date.now()}`,
                kind: 'image',
                label: file.name || 'Screenshot',
                mimeType: item.type,
                dataBase64: base64,
              },
            ],
          });
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && chips.length === 0) return;

    // Direct typed slash command execution
    if (trimmed.startsWith('/') && !trimmed.includes('\n') && !trimmed.includes(' ')) {
      const cmd = trimmed.slice(1).toLowerCase();
      if (BUILTIN_SLASH_COMMANDS.some((c) => c.name === cmd)) {
        setText('');
        setSlashQuery(null);
        onUpdateThread({ draftText: '' });
        if (cmd === 'status') setStatsOpen(true);
        else onSlashAction(cmd);
        return;
      }
    }

    if (isBusy) {
      if (followUpMode === 'queue') {
        onEnqueuePrompt(trimmed, chips);
      } else {
        onSteerThread(trimmed, chips);
      }
    } else {
      onSendPrompt(trimmed, chips);
    }
    setText('');
    onUpdateThread({ draftText: '', draftChips: [] });
    setSuggestions([]);
    setSlashQuery(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.shiftKey && e.key === 'Tab') {
      e.preventDefault();
      onUpdateThread({
        interactionMode: thread.interactionMode === 'plan' ? 'build' : 'plan',
      });
      return;
    }

    const activeListLen = suggestions.length || slashItems.length;
    if (activeListLen > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % activeListLen);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + activeListLen) % activeListLen);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (suggestions.length > 0) applySuggestion(suggestions[selectedIdx]);
        else if (slashItems.length > 0) applySlashItem(slashItems[selectedIdx]);
        return;
      }
      if (e.key === 'Escape') {
        setSuggestions([]);
        setSlashQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div ref={dockRef} className="floating-composer-dock">
      <div className="floating-composer-inner">
        {suggestions.length > 0 && (
          <FrostedSurface
            variant="popover"
            cornerRadius={11}
            className="codex-popover"
            role="listbox"
            aria-label="File and symbol suggestions"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              marginBottom: 8,
              zIndex: 'var(--z-popover)',
              '--transform-origin': 'bottom left',
            } as React.CSSProperties}
          >
            <div style={{ maxHeight: 240, overflowY: 'auto', padding: 6 }}>
              {suggestions.map((s, idx) => (
                <button
                  key={`${s.kind}-${s.label}-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={idx === selectedIdx}
                  className="pressable hover-surface"
                  onClick={() => applySuggestion(s)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    border: 'none',
                    borderRadius: 7,
                    background: idx === selectedIdx ? 'var(--bg-surface-active)' : 'transparent',
                    textAlign: 'left',
                    fontSize: 12.5,
                  }}
                >
                  {s.kind === 'symbol' ? (
                    <Code2 size={13} style={{ color: 'var(--accent-blue)' }} aria-hidden="true" />
                  ) : (
                    <FileCode2 size={13} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
                  )}
                  <span className="mono">{s.label}</span>
                </button>
              ))}
            </div>
          </FrostedSurface>
        )}

        <SlashMenu items={slashItems} selectedIdx={selectedIdx} onSelect={applySlashItem} />

        {/* Queued Follow-ups Banner */}
        {queued.length > 0 && (
          <div
            style={{
              marginBottom: 8,
              padding: '6px 10px',
              borderRadius: 12,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Clock size={11} aria-hidden="true" />
              <span>Queued follow-ups ({queued.length})</span>
            </div>
            {queued.map((q) => (
              <div
                key={q.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.content}
                </span>
                <button
                  type="button"
                  className="pressable hover-surface"
                  onClick={() => onRemoveQueuedPrompt(q.id)}
                  aria-label="Remove queued message"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    padding: 2,
                    display: 'inline-flex',
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {voice.error && (
          <div
            role="status"
            style={{
              marginBottom: 6,
              padding: '6px 10px',
              borderRadius: 9,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
              fontSize: 12,
              color: 'var(--accent-amber)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span>{voice.error}</span>
            <button
              type="button"
              onClick={voice.clearError}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}

        <FrostedSurface
          variant="composer"
          cornerRadius={14}
          className="codex-composer-shell"
        >
          {isBusy && (
            <div
              role="status"
              aria-atomic="true"
              style={{
                padding: '6px 14px',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 11.5,
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span className="status-orb" aria-hidden="true" />
              <span className="shimmer-text">
                {thread.status === 'queued'
                  ? 'Waiting in execution queue...'
                  : thread.status === 'scouting'
                    ? 'Inspecting relevant files & symbols...'
                    : thread.status === 'verifying'
                      ? 'Verifying changes...'
                      : thread.status === 'awaiting_input'
                        ? 'Waiting for your answer above...'
                        : `Working — type below to ${followUpMode === 'queue' ? 'queue follow-up' : 'steer next step'}`}
              </span>
            </div>
          )}

          {chips.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                padding: '10px 14px 0',
              }}
            >
              {chips.map((c) => {
                const isImageGen =
                  c.kind === 'skill' && (c.skillName ?? c.label).replace(/^\/+/, '') === 'image-gen';
                return (
                  <span
                    key={c.id}
                    className="codex-pill"
                    data-highlighted={isImageGen ? 'true' : undefined}
                    style={{ height: 24, padding: '0 6px 0 8px', maxWidth: 260 }}
                  >
                    {c.kind === 'comment' ? (
                      <MessageSquare size={11} style={{ color: 'var(--accent-blue)' }} aria-hidden="true" />
                    ) : isImageGen ? (
                      <Wand2 size={11} style={{ color: 'var(--accent-brand)' }} aria-hidden="true" />
                    ) : c.kind === 'skill' ? (
                      <Sparkles size={11} style={{ color: 'var(--accent-brand)' }} aria-hidden="true" />
                    ) : c.kind === 'image' ? (
                      <ImageIcon size={11} aria-hidden="true" />
                    ) : c.kind === 'terminal' ? (
                      <Terminal size={11} aria-hidden="true" />
                    ) : (
                      <FileCode2 size={11} aria-hidden="true" />
                    )}
                    <span className="codex-pill-label mono" style={{ fontSize: 11 }}>
                      {isImageGen ? 'Create image' : c.label}
                    </span>
                    <button
                      type="button"
                      className="pressable"
                      onClick={() =>
                        onUpdateThread({ draftChips: chips.filter((x) => x.id !== c.id) })
                      }
                      aria-label={`Remove attachment ${c.label}`}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 2,
                        display: 'inline-flex',
                        color: 'var(--text-muted)',
                      }}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => void handleTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              chips.some(
                (c) => c.kind === 'skill' && (c.skillName ?? c.label).replace(/^\/+/, '') === 'image-gen',
              )
                ? 'Describe an image to generate locally...'
                : thread.interactionMode === 'plan'
                  ? 'Describe what to plan... (@ for files, / for commands, Shift+Tab for Build)'
                  : 'Ask SmolCode anything, @ to add files, / for commands'
            }
            aria-label="Prompt composer"
            rows={2}
            style={{
              width: '100%',
              resize: 'none',
              border: 'none',
              background: 'transparent',
              padding: '13px 15px 6px',
              fontSize: 14,
              lineHeight: 1.5,
              maxHeight: 200,
              outline: 'none',
            }}
          />

          <ComposerBar
            thread={thread}
            models={models}
            vram={vram}
            latestTelemetry={latestTelemetry}
            showAdvancedDualModel={showAdvancedDualModel}
            pinFastToCpu={pinFastToCpu}
            activeContextTokens={activeContextTokens}
            contextBudget={contextBudget}
            isBusy={isBusy}
            canSend={text.trim().length > 0 || chips.length > 0}
            followUpMode={followUpMode}
            recording={voice.recording}
            transcribing={voice.transcribing}
            statsOpen={statsOpen}
            imageGenSize={imageGenSize}
            onChangeImageGenSize={onChangeImageGenSize}
            onSetStatsOpen={setStatsOpen}
            onToggleFollowUpMode={() =>
              setFollowUpMode((m) => (m === 'queue' ? 'steer' : 'queue'))
            }
            onToggleRecording={() => void voice.toggleRecording()}
            onAttachFiles={onAttachFiles}
            onOpenSkills={onOpenSkills}
            onCompactThread={() => onSlashAction('compact')}
            onUpdateThread={onUpdateThread}
            onSend={submit}
            onStop={onStopThread}
          />
        </FrostedSurface>
      </div>
    </div>
  );
}
