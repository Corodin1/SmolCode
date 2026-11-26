import {
  ArrowLeft,
  Bell,
  Check,
  Cpu,
  Download,
  FolderCog,
  FolderOpen,
  Keyboard,
  Palette,
  Plug,
  RefreshCw,
  Sliders,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ACCENT_SWATCHES, THEME_PRESETS } from '../../shared/theme-presets';
import type {
  AccentColor,
  AppSettings,
  ApprovalPolicy,
  FontSizeScale,
  GlassIntensity,
  ImageGenProvider,
  ImageGenSize,
  ImageModelDownloadProgress,
  ImageModelPresetId,
  LocalImageBackendStatus,
  McpServerConfig,
  OllamaModelInfo,
  PreferredEditor,
  ProjectEnvironment,
  ProjectRecord,
  SettingsTab,
  ThemeMode,
  ThemePreset,
  UiDensity,
  VramScheduleMode,
  VramStatus,
} from '../../shared/types';
import { playCompletionChime } from '../../utils/audio-notify';
import { EffortSlider } from '../Composer/EffortSlider';
import { KEYBOARD_SHORTCUTS } from '../Modals/ShortcutsModal';

interface SettingsViewProps {
  tab: SettingsTab;
  onChangeTab: (tab: SettingsTab) => void;
  settings: AppSettings;
  models: OllamaModelInfo[];
  vram: VramStatus;
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  mcpServers: McpServerConfig[];
  onBack: () => void;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onSaveMcpServer: (server: Partial<McpServerConfig> & { name: string }) => Promise<void>;
  onDeleteMcpServer: (id: string) => Promise<void>;
  onTestMcpServer: (id: string) => Promise<void>;
}

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Sliders }> = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'models', label: 'Models & Inference', icon: Cpu },
  { id: 'environments', label: 'Environments', icon: FolderCog },
  { id: 'mcp', label: 'MCP Servers', icon: Plug },
  { id: 'voice', label: 'Voice & Notifications', icon: Bell },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
];

export function SettingsView({
  tab,
  onChangeTab,
  settings,
  models,
  vram,
  projects,
  activeProject,
  mcpServers,
  onBack,
  onSaveSettings,
  onRefreshModels,
  onSaveMcpServer,
  onDeleteMcpServer,
  onTestMcpServer,
}: SettingsViewProps) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [savedNotice, setSavedNotice] = useState(false);

  const [envProjectId, setEnvProjectId] = useState(activeProject?.id ?? projects[0]?.id ?? '');
  const [projEnv, setProjEnv] = useState<ProjectEnvironment>({
    projectId: envProjectId,
    setupScript: '',
    envVarsJson: '{}',
  });

  const [mcpName, setMcpName] = useState('');
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [imageBackends, setImageBackends] = useState<LocalImageBackendStatus | null>(null);
  const [probingImageBackends, setProbingImageBackends] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<ImageModelDownloadProgress | null>(null);

  const probeImageBackends = useCallback(async () => {
    if (!window.smolcode?.detectLocalImageBackends) return;
    setProbingImageBackends(true);
    try {
      const res = await window.smolcode.detectLocalImageBackends();
      setImageBackends(res);
    } finally {
      setProbingImageBackends(false);
    }
  }, []);

  const handleDownloadPreset = async (presetId: ImageModelPresetId) => {
    if (!window.smolcode?.downloadLocalImageModel) return;
    setDownloadProgress({
      presetId,
      fileName: presetId,
      receivedBytes: 0,
      totalBytes: 0,
      status: 'downloading',
    });
    const res = await window.smolcode.downloadLocalImageModel(presetId);
    if (res.ok && res.savedPath) {
      setDraft((prev) => ({ ...prev, sdCppModelPath: res.savedPath! }));
      await applySettings({ sdCppModelPath: res.savedPath });
      await probeImageBackends();
    } else if (!res.ok) {
      setDownloadProgress({
        presetId,
        fileName: presetId,
        receivedBytes: 0,
        totalBytes: 0,
        status: 'error',
        error: res.error || 'Download failed',
      });
    }
  };

  useEffect(() => {
    if (!window.smolcode?.onAgentEvent) return;
    return window.smolcode.onAgentEvent((ev) => {
      if (ev.type === 'image_model_download_progress') {
        setDownloadProgress(ev.progress);
      }
    });
  }, []);

  useEffect(() => {
    if (!envProjectId || !window.smolcode) return;
    void window.smolcode.getProjectEnvironment(envProjectId).then(setProjEnv);
  }, [envProjectId]);

  useEffect(() => {
    if (tab !== 'models' || !window.smolcode?.detectLocalImageBackends) return;
    let cancelled = false;
    void window.smolcode
      .detectLocalImageBackends()
      .then((res) => {
        if (!cancelled) setImageBackends(res);
      })
      .catch(() => {
        // Ignore probe failures in test/offline environments
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const applySettings = async (patch: Partial<AppSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    await onSaveSettings(patch);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 1800);
  };

  const handleAddMcp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcpName.trim()) return;
    await onSaveMcpServer({
      name: mcpName.trim(),
      transport: mcpTransport,
      command: mcpTransport === 'stdio' ? mcpCommand.trim() : undefined,
      args: mcpTransport === 'stdio' ? mcpArgs.split(/\s+/).filter(Boolean) : [],
      url: mcpTransport === 'http' ? mcpUrl.trim() : undefined,
      enabled: true,
    });
    setMcpName('');
    setMcpCommand('');
    setMcpArgs('');
    setMcpUrl('');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="pressable hover-surface"
            onClick={onBack}
            style={{
              height: 30,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
            }}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <span>Back</span>
          </button>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Settings</h1>
        </div>
        {savedNotice && (
          <span role="status" style={{ fontSize: 12, color: 'var(--accent-green)' }}>
            Saved
          </span>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left Settings Nav */}
        <nav
          aria-label="Settings categories"
          style={{
            width: 220,
            borderRight: '1px solid var(--border-subtle)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                className="sidebar-nav-btn pressable hover-surface"
                data-active={tab === t.id}
                onClick={() => onChangeTab(t.id)}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Right Settings Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
          <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {tab === 'general' && (
              <>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>General</h2>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>Preferred External Editor</span>
                  <select
                    value={draft.preferredEditor}
                    onChange={(e) =>
                      void applySettings({ preferredEditor: e.target.value as PreferredEditor })
                    }
                    style={{
                      height: 34,
                      padding: '0 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    <option value="auto">Auto-detect (Cursor / VS Code / Windsurf)</option>
                    <option value="vscode">Visual Studio Code</option>
                    <option value="cursor">Cursor</option>
                    <option value="windsurf">Windsurf</option>
                    <option value="explorer">System File Explorer</option>
                    <option value="terminal">External Terminal</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>Integrated Terminal Shell</span>
                  <select
                    value={draft.defaultShell}
                    onChange={(e) =>
                      void applySettings({
                        defaultShell: e.target.value as AppSettings['defaultShell'],
                      })
                    }
                    style={{
                      height: 34,
                      padding: '0 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    <option value="auto">Auto</option>
                    <option value="pwsh">PowerShell 7</option>
                    <option value="powershell">Windows PowerShell</option>
                    <option value="git-bash">Git Bash</option>
                    <option value="wsl">WSL</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>Default Approval Policy</span>
                  <select
                    value={draft.defaultApprovalPolicy}
                    onChange={(e) =>
                      void applySettings({
                        defaultApprovalPolicy: e.target.value as ApprovalPolicy,
                      })
                    }
                    style={{
                      height: 34,
                      padding: '0 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    <option value="read-only">Read-only (no edits or shell mutations)</option>
                    <option value="auto">Auto (edits & safe checks auto, ask on shell)</option>
                    <option value="full-access">Full Access (run commands without prompts)</option>
                  </select>
                </label>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                    fontSize: 12.5,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>Internet Lookup via Obscura (web_lookup)</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      Allow the agent to look up external documentation and package APIs using Obscura.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draft.webLookupEnabled}
                    onChange={(e) => void applySettings({ webLookupEnabled: e.target.checked })}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>Obscura Binary Path (optional)</span>
                  <input
                    type="text"
                    value={draft.obscuraPath}
                    placeholder="Auto-detect (C:\Tools\obscura\obscura.exe or PATH)"
                    onChange={(e) => setDraft({ ...draft, obscuraPath: e.target.value })}
                    onBlur={() => void applySettings({ obscuraPath: draft.obscuraPath })}
                    style={{
                      height: 34,
                      padding: '0 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-elevated)',
                    }}
                  />
                </label>
              </>
            )}

            {tab === 'appearance' && (
              <>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Appearance</h2>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>Color Mode</span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => {
                      const active = draft.theme === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          className="pressable hover-surface"
                          onClick={() => {
                            const matchingPreset = THEME_PRESETS.find((p) => p.id === draft.themePreset);
                            const nextPreset: ThemePreset | undefined =
                              mode === 'light' && matchingPreset?.base !== 'light'
                                ? 'alabaster'
                                : mode === 'dark' && matchingPreset?.base !== 'dark'
                                  ? 'obsidian'
                                  : undefined;
                            void applySettings({
                              theme: mode,
                              ...(nextPreset ? { themePreset: nextPreset } : {}),
                            });
                          }}
                          style={{
                            padding: '10px 12px',
                            borderRadius: 10,
                            border: active
                              ? '2px solid var(--accent-brand)'
                              : '1px solid var(--border-default)',
                            background: active ? 'var(--accent-brand-soft)' : 'var(--bg-elevated)',
                            textTransform: 'capitalize',
                            fontWeight: 500,
                            fontSize: 13,
                          }}
                        >
                          {mode}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>Theme Preset</span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                    {THEME_PRESETS.map((preset) => {
                      const active = draft.themePreset === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className="pressable hover-surface"
                          onClick={() =>
                            void applySettings({
                              themePreset: preset.id,
                              theme: preset.base,
                            })
                          }
                          style={{
                            padding: 10,
                            borderRadius: 11,
                            border: active
                              ? '2px solid var(--accent-brand)'
                              : '1px solid var(--border-default)',
                            background: 'var(--bg-elevated)',
                            textAlign: 'left',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                          }}
                        >
                          <div
                            style={{
                              height: 36,
                              borderRadius: 7,
                              overflow: 'hidden',
                              border: '1px solid rgba(128,128,128,0.22)',
                              display: 'flex',
                            }}
                          >
                            <div style={{ width: '32%', background: preset.sidebarBg }} />
                            <div
                              style={{
                                flex: 1,
                                background: preset.canvasBg,
                                padding: 6,
                                display: 'flex',
                                alignItems: 'flex-end',
                                justifyContent: 'flex-end',
                              }}
                            >
                              <span
                                style={{
                                  width: 14,
                                  height: 6,
                                  borderRadius: 3,
                                  background: preset.elevatedBg,
                                  border: `1px solid ${preset.symbolColor}33`,
                                }}
                              />
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{preset.label}</span>
                            {active && <Check size={12} style={{ color: 'var(--accent-brand)' }} aria-hidden="true" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>Accent Color</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {ACCENT_SWATCHES.map((sw) => {
                      const active = (draft.accentColor ?? 'blue') === sw.id;
                      const isLightBase =
                        draft.theme === 'light' ||
                        (draft.theme === 'system' &&
                          !window.matchMedia?.('(prefers-color-scheme: dark)').matches);
                      return (
                        <button
                          key={sw.id}
                          type="button"
                          className="codex-pill pressable hover-surface"
                          onClick={() => void applySettings({ accentColor: sw.id as AccentColor })}
                          style={{
                            height: 30,
                            padding: '0 11px',
                            borderColor: active ? 'var(--accent-brand)' : 'var(--border-default)',
                            background: active ? 'var(--accent-brand-soft)' : 'var(--bg-elevated)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <span
                            style={{
                              width: 11,
                              height: 11,
                              borderRadius: '50%',
                              background: isLightBase ? sw.swatchLight : sw.swatchDark,
                              flexShrink: 0,
                            }}
                            aria-hidden="true"
                          />
                          <span>{sw.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>Interface Density</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {(['compact', 'comfortable', 'spacious'] as UiDensity[]).map((d) => {
                        const active = (draft.uiDensity ?? 'comfortable') === d;
                        return (
                          <button
                            key={d}
                            type="button"
                            className="pressable hover-surface"
                            onClick={() => void applySettings({ uiDensity: d })}
                            style={{
                              flex: 1,
                              height: 32,
                              borderRadius: 8,
                              border: active
                                ? '1.5px solid var(--accent-brand)'
                                : '1px solid var(--border-default)',
                              background: active ? 'var(--accent-brand-soft)' : 'var(--bg-elevated)',
                              textTransform: 'capitalize',
                              fontSize: 12,
                              fontWeight: 500,
                            }}
                          >
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>Text Scale</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {(
                        [
                          { id: 'sm', label: 'Small' },
                          { id: 'md', label: 'Default' },
                          { id: 'lg', label: 'Large' },
                        ] as Array<{ id: FontSizeScale; label: string }>
                      ).map((sz) => {
                        const active = (draft.fontSize ?? 'md') === sz.id;
                        return (
                          <button
                            key={sz.id}
                            type="button"
                            className="pressable hover-surface"
                            onClick={() => void applySettings({ fontSize: sz.id })}
                            style={{
                              flex: 1,
                              height: 32,
                              borderRadius: 8,
                              border: active
                                ? '1.5px solid var(--accent-brand)'
                                : '1px solid var(--border-default)',
                              background: active ? 'var(--accent-brand-soft)' : 'var(--bg-elevated)',
                              fontSize: 12,
                              fontWeight: 500,
                            }}
                          >
                            {sz.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>Frosted Glass & Acrylic</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      Controls Windows 11 Acrylic translucency and color-shifted frosted blur on floating panels.
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, maxWidth: 340 }}>
                    {(['off', 'subtle', 'rich'] as GlassIntensity[]).map((g) => {
                      const active = (draft.glassIntensity ?? 'subtle') === g;
                      return (
                        <button
                          key={g}
                          type="button"
                          className="pressable hover-surface"
                          onClick={() => void applySettings({ glassIntensity: g })}
                          style={{
                            flex: 1,
                            height: 32,
                            borderRadius: 8,
                            border: active
                              ? '1.5px solid var(--accent-brand)'
                              : '1px solid var(--border-default)',
                            background: active ? 'var(--accent-brand-soft)' : 'var(--bg-elevated)',
                            textTransform: 'capitalize',
                            fontSize: 12,
                            fontWeight: 500,
                          }}
                        >
                          {g}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(draft.reduceMotion)}
                    onChange={(e) => void applySettings({ reduceMotion: e.target.checked })}
                  />
                  <span>Reduce motion (disable spatial transforms & text shimmer)</span>
                </label>
              </>
            )}

            {tab === 'models' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Models & Inference</h2>
                  <button
                    type="button"
                    className="pressable hover-surface"
                    onClick={() => void onRefreshModels()}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 7,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-surface)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 12,
                    }}
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    <span>Refresh catalog</span>
                  </button>
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>Ollama Base URL</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="url"
                      value={draft.ollamaBaseUrl}
                      onChange={(e) => setDraft({ ...draft, ollamaBaseUrl: e.target.value })}
                      style={{
                        flex: 1,
                        height: 34,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-elevated)',
                      }}
                    />
                    <button
                      type="button"
                      className="pressable codex-primary-btn"
                      onClick={() => void applySettings({ ollamaBaseUrl: draft.ollamaBaseUrl })}
                      style={{
                        height: 34,
                        padding: '0 14px',
                        borderRadius: 8,
                        border: 'none',
                        background: 'var(--accent-primary)',
                        color: 'var(--accent-primary-fg)',
                        fontSize: 12.5,
                        fontWeight: 500,
                      }}
                    >
                      Apply
                    </button>
                  </div>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>Default Model</span>
                  <select
                    value={draft.defaultMainModel}
                    onChange={(e) =>
                      void applySettings({
                        defaultMainModel: e.target.value,
                        ...(draft.showAdvancedDualModel ? {} : { defaultFastModel: e.target.value }),
                      })
                    }
                    style={{
                      height: 34,
                      padding: '0 8px',
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    {models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name} ({m.parameterSize})
                      </option>
                    ))}
                    {draft.defaultMainModel && !models.some((m) => m.name === draft.defaultMainModel) && (
                      <option value={draft.defaultMainModel}>{draft.defaultMainModel}</option>
                    )}
                  </select>
                </label>

                <div
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>Default Reasoning Effort</span>
                  <EffortSlider
                    variant="inline"
                    value={draft.defaultEffort}
                    onChange={(nextEffort) => void applySettings({ defaultEffort: nextEffort })}
                  />
                </div>

                {/* Optional Modular Dual-Model & VRAM Controls */}
                <div
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-sidebar)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={draft.showAdvancedDualModel}
                      onChange={(e) =>
                        void applySettings({ showAdvancedDualModel: e.target.checked })
                      }
                    />
                    <span style={{ fontWeight: 500 }}>
                      Enable separate Fast Scout model pill in Composer
                    </span>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                    <span style={{ fontWeight: 500 }}>Fast Helper Model (Titles & Scout)</span>
                    <select
                      value={draft.defaultFastModel}
                      onChange={(e) => void applySettings({ defaultFastModel: e.target.value })}
                      style={{
                        height: 32,
                        padding: '0 8px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-canvas)',
                      }}
                    >
                      {models.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                    <span style={{ fontWeight: 500 }}>VRAM Scheduler Strategy</span>
                    <select
                      value={draft.vramScheduleMode}
                      onChange={(e) =>
                        void applySettings({
                          vramScheduleMode: e.target.value as VramScheduleMode,
                        })
                      }
                      style={{
                        height: 32,
                        padding: '0 8px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-canvas)',
                      }}
                    >
                      <option value="stage-batched">Stage-Batched (Minimal GPU swapping)</option>
                      <option value="cpu-pin-fast">Pin Fast Model to CPU RAM</option>
                      <option value="strict-role-split">Strict Role Split</option>
                    </select>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={draft.pinFastToCpu}
                      onChange={(e) => void applySettings({ pinFastToCpu: e.target.checked })}
                    />
                    <span>Force Fast Model onto CPU (`num_gpu: 0`) when distinct from Primary</span>
                  </label>

                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    VRAM: {vram.totalMb > 0 ? `${vram.freeMb} / ${vram.totalMb} MiB free` : 'Probe unavailable'}
                  </div>
                </div>

                {/* Local Image Generation (/image-gen skill & generate_image tool) */}
                <div
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-sidebar)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <Wand2 size={14} style={{ color: 'var(--accent-brand)' }} aria-hidden="true" />
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>Local Image Generation</span>
                    </div>
                    <button
                      type="button"
                      className="pressable hover-surface"
                      disabled={probingImageBackends}
                      onClick={() => void probeImageBackends()}
                      style={{
                        height: 26,
                        padding: '0 9px',
                        borderRadius: 7,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-elevated)',
                        fontSize: 11.5,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <RefreshCw size={11} aria-hidden="true" />
                      <span>{probingImageBackends ? 'Scanning...' : 'Detect backends'}</span>
                    </button>
                  </div>

                  {imageBackends && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <span
                        className="codex-pill"
                        data-highlighted={Boolean(imageBackends.sdCppPath)}
                        style={{ height: 24, fontSize: 11 }}
                      >
                        {imageBackends.sdCppBundled
                          ? 'Bundled Engine: sd-cli (ready)'
                          : `sd.cpp: ${imageBackends.sdCppPath ? 'found' : 'not found'}`}
                      </span>
                      <span
                        className="codex-pill"
                        data-highlighted={imageBackends.localModelFiles.length > 0 || Boolean(draft.sdCppModelPath)}
                        style={{ height: 24, fontSize: 11 }}
                      >
                        Local Models: {imageBackends.localModelFiles.length}
                      </span>
                      <span
                        className="codex-pill"
                        data-highlighted={imageBackends.ollamaImageModels.length > 0}
                        style={{ height: 24, fontSize: 11 }}
                      >
                        Ollama Image: {imageBackends.ollamaImageModels.length > 0 ? imageBackends.ollamaImageModels.join(', ') : 'none pulled'}
                      </span>
                      <span
                        className="codex-pill"
                        data-highlighted={imageBackends.comfyUiUp}
                        style={{ height: 24, fontSize: 11 }}
                      >
                        ComfyUI: {imageBackends.comfyUiUp ? 'online' : 'offline'}
                      </span>
                      <span
                        className="codex-pill"
                        data-highlighted={imageBackends.a1111Up}
                        style={{ height: 24, fontSize: 11 }}
                      >
                        A1111: {imageBackends.a1111Up ? 'online' : 'offline'}
                      </span>
                    </div>
                  )}

                  {/* Built-in 1-click starter model download for bundled sd-cli engine */}
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 9,
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-elevated)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontSize: 12 }}>
                        <div style={{ fontWeight: 500 }}>Starter Models for Bundled Engine</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          SmolCode bundles sd-cli (Vulkan) internally — download a single-file model below or pick your own checkpoint.
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <button
                        type="button"
                        className="codex-pill pressable hover-surface"
                        disabled={downloadProgress?.status === 'downloading'}
                        onClick={() => void handleDownloadPreset('dreamshaper-8')}
                        style={{ height: 28 }}
                      >
                        <Download size={12} aria-hidden="true" />
                        <span>DreamShaper 8 (2.0 GB · 8GB GPU)</span>
                      </button>
                      <button
                        type="button"
                        className="codex-pill pressable hover-surface"
                        disabled={downloadProgress?.status === 'downloading'}
                        onClick={() => void handleDownloadPreset('sdxl-turbo')}
                        style={{ height: 28 }}
                      >
                        <Download size={12} aria-hidden="true" />
                        <span>SDXL Turbo (6.5 GB · 4-step)</span>
                      </button>
                    </div>
                    {downloadProgress && (
                      <div style={{ fontSize: 11.5, color: downloadProgress.status === 'error' ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
                        {downloadProgress.status === 'downloading'
                          ? `Downloading ${downloadProgress.fileName}: ${(downloadProgress.receivedBytes / 1_048_576).toFixed(1)} MB${
                              downloadProgress.totalBytes > 0
                                ? ` / ${(downloadProgress.totalBytes / 1_048_576).toFixed(0)} MB (${Math.round((downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100)}%)`
                                : ''
                            }`
                          : downloadProgress.status === 'done'
                            ? `Ready: ${downloadProgress.savedPath}`
                            : `Download failed: ${downloadProgress.error}`}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>Backend Provider</span>
                      <select
                        value={draft.imageGenProvider}
                        onChange={(e) =>
                          void applySettings({
                            imageGenProvider: e.target.value as ImageGenProvider,
                          })
                        }
                        style={{
                          height: 32,
                          padding: '0 8px',
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-canvas)',
                        }}
                      >
                        <option value="auto">Auto (best available local)</option>
                        <option value="ollama">Ollama (x/flux2-klein / x/z-image-turbo)</option>
                        <option value="sd-cpp">stable-diffusion.cpp (sd-cli)</option>
                        <option value="comfyui">ComfyUI (local server)</option>
                        <option value="a1111">Automatic1111 / Forge API</option>
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>Default Image Size</span>
                      <select
                        value={draft.imageGenDefaultSize}
                        onChange={(e) =>
                          void applySettings({
                            imageGenDefaultSize: e.target.value as ImageGenSize,
                          })
                        }
                        style={{
                          height: 32,
                          padding: '0 8px',
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-canvas)',
                        }}
                      >
                        <option value="1024x1024">1024×1024 (Square 1:1)</option>
                        <option value="1024x576">1024×576 (Landscape 16:9)</option>
                        <option value="576x1024">576×1024 (Portrait 9:16)</option>
                        <option value="768x768">768×768 (Balanced)</option>
                        <option value="512x512">512×512 (Fast draft)</option>
                      </select>
                    </label>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>Ollama Image Model</span>
                      <input
                        type="text"
                        value={draft.ollamaImageModel}
                        placeholder="x/flux2-klein"
                        onChange={(e) => setDraft({ ...draft, ollamaImageModel: e.target.value })}
                        onBlur={() => void applySettings({ ollamaImageModel: draft.ollamaImageModel })}
                        style={{
                          height: 32,
                          padding: '0 9px',
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-canvas)',
                        }}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>Local Server URL (ComfyUI / A1111)</span>
                      <input
                        type="url"
                        value={draft.imageGenLocalUrl}
                        placeholder="http://127.0.0.1:8188"
                        onChange={(e) => setDraft({ ...draft, imageGenLocalUrl: e.target.value })}
                        onBlur={() => void applySettings({ imageGenLocalUrl: draft.imageGenLocalUrl })}
                        style={{
                          height: 32,
                          padding: '0 9px',
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-canvas)',
                        }}
                      />
                    </label>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>sd-cli Executable Override (optional)</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="text"
                          value={draft.sdCppPath}
                          placeholder="Uses bundled sd-cli automatically"
                          onChange={(e) => setDraft({ ...draft, sdCppPath: e.target.value })}
                          onBlur={() => void applySettings({ sdCppPath: draft.sdCppPath })}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            height: 32,
                            padding: '0 9px',
                            borderRadius: 8,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-canvas)',
                          }}
                        />
                        <button
                          type="button"
                          className="pressable hover-surface"
                          aria-label="Browse sd-cli binary"
                          onClick={() => {
                            void window.smolcode?.pickLocalImageFile('binary').then((picked) => {
                              if (picked) {
                                setDraft((p) => ({ ...p, sdCppPath: picked }));
                                void applySettings({ sdCppPath: picked });
                              }
                            });
                          }}
                          style={{
                            height: 32,
                            padding: '0 9px',
                            borderRadius: 8,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-elevated)',
                            display: 'inline-flex',
                            alignItems: 'center',
                          }}
                        >
                          <FolderOpen size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>Local Model / Checkpoint Path</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="text"
                          value={draft.sdCppModelPath}
                          placeholder="Auto-uses ~/.smolcode/models/image/*"
                          onChange={(e) => setDraft({ ...draft, sdCppModelPath: e.target.value })}
                          onBlur={() => void applySettings({ sdCppModelPath: draft.sdCppModelPath })}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            height: 32,
                            padding: '0 9px',
                            borderRadius: 8,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-canvas)',
                          }}
                        />
                        <button
                          type="button"
                          className="pressable hover-surface"
                          aria-label="Browse diffusion model"
                          onClick={() => {
                            void window.smolcode?.pickLocalImageFile('model').then((picked) => {
                              if (picked) {
                                setDraft((p) => ({ ...p, sdCppModelPath: picked }));
                                void applySettings({ sdCppModelPath: picked });
                              }
                            });
                          }}
                          style={{
                            height: 32,
                            padding: '0 9px',
                            borderRadius: 8,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-elevated)',
                            display: 'inline-flex',
                            alignItems: 'center',
                          }}
                        >
                          <FolderOpen size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </label>
                  </div>

                  <details style={{ fontSize: 12 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontWeight: 500 }}>
                      Advanced sd.cpp options (VAE & CLI flags)
                    </summary>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 }}>
                        <span>VAE Path (optional)</span>
                        <input
                          type="text"
                          value={draft.sdCppVaePath}
                          placeholder="C:\Models\ae.safetensors"
                          onChange={(e) => setDraft({ ...draft, sdCppVaePath: e.target.value })}
                          onBlur={() => void applySettings({ sdCppVaePath: draft.sdCppVaePath })}
                          style={{
                            height: 30,
                            padding: '0 8px',
                            borderRadius: 7,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-canvas)',
                          }}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 }}>
                        <span>Extra sd-cli Args (optional)</span>
                        <input
                          type="text"
                          value={draft.sdCppExtraArgs}
                          placeholder="--cfg-scale 1.0 --diffusion-fa"
                          onChange={(e) => setDraft({ ...draft, sdCppExtraArgs: e.target.value })}
                          onBlur={() => void applySettings({ sdCppExtraArgs: draft.sdCppExtraArgs })}
                          style={{
                            height: 30,
                            padding: '0 8px',
                            borderRadius: 7,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-canvas)',
                          }}
                        />
                      </label>
                    </div>
                  </details>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={draft.imageGenUnloadOllama}
                      onChange={(e) =>
                        void applySettings({ imageGenUnloadOllama: e.target.checked })
                      }
                    />
                    <span>Unload active Ollama text LLM before generating images (recommended for 8 GB VRAM)</span>
                  </label>
                </div>
              </>
            )}

            {tab === 'environments' && (
              <>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Workspace Environments</h2>
                {projects.length === 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Open a project folder first to configure its local environment variables.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <select
                      value={envProjectId}
                      onChange={(e) => setEnvProjectId(e.target.value)}
                      style={{
                        height: 34,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-elevated)',
                      }}
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.rootPath})
                        </option>
                      ))}
                    </select>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>Workspace Setup Command</span>
                      <textarea
                        rows={3}
                        className="mono"
                        value={projEnv.setupScript}
                        onChange={(e) => setProjEnv({ ...projEnv, setupScript: e.target.value })}
                        placeholder="e.g. npm ci"
                        style={{
                          padding: 10,
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-elevated)',
                          fontSize: 12,
                        }}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>Environment Variables (JSON)</span>
                      <textarea
                        rows={3}
                        className="mono"
                        value={projEnv.envVarsJson}
                        onChange={(e) => setProjEnv({ ...projEnv, envVarsJson: e.target.value })}
                        style={{
                          padding: 10,
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-elevated)',
                          fontSize: 12,
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      className="pressable codex-primary-btn"
                      onClick={() => void window.smolcode.saveProjectEnvironment(projEnv)}
                      style={{
                        alignSelf: 'flex-start',
                        height: 32,
                        padding: '0 14px',
                        borderRadius: 8,
                        border: 'none',
                        background: 'var(--accent-primary)',
                        color: 'var(--accent-primary-fg)',
                        fontSize: 12.5,
                        fontWeight: 500,
                      }}
                    >
                      Save environment
                    </button>
                  </div>
                )}
              </>
            )}

            {tab === 'mcp' && (
              <>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>MCP Servers</h2>
                <form
                  onSubmit={(e) => void handleAddMcp(e)}
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8 }}>
                    <input
                      type="text"
                      value={mcpName}
                      onChange={(e) => setMcpName(e.target.value)}
                      placeholder="Server name (e.g. filesystem)"
                      required
                      style={{
                        height: 32,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-canvas)',
                        fontSize: 12.5,
                      }}
                    />
                    <select
                      value={mcpTransport}
                      onChange={(e) => setMcpTransport(e.target.value as 'stdio' | 'http')}
                      style={{
                        height: 32,
                        padding: '0 8px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-canvas)',
                        fontSize: 12.5,
                      }}
                    >
                      <option value="stdio">stdio</option>
                      <option value="http">http</option>
                    </select>
                  </div>

                  {mcpTransport === 'stdio' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <input
                        type="text"
                        value={mcpCommand}
                        onChange={(e) => setMcpCommand(e.target.value)}
                        placeholder="Command (e.g. npx)"
                        className="mono"
                        style={{
                          height: 32,
                          padding: '0 10px',
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-canvas)',
                          fontSize: 12,
                        }}
                      />
                      <input
                        type="text"
                        value={mcpArgs}
                        onChange={(e) => setMcpArgs(e.target.value)}
                        placeholder="Args (space separated)"
                        className="mono"
                        style={{
                          height: 32,
                          padding: '0 10px',
                          borderRadius: 8,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-canvas)',
                          fontSize: 12,
                        }}
                      />
                    </div>
                  ) : (
                    <input
                      type="url"
                      value={mcpUrl}
                      onChange={(e) => setMcpUrl(e.target.value)}
                      placeholder="http://127.0.0.1:8080/mcp"
                      className="mono"
                      style={{
                        height: 32,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-canvas)',
                        fontSize: 12,
                      }}
                    />
                  )}

                  <button
                    type="submit"
                    className="pressable codex-primary-btn"
                    style={{
                      alignSelf: 'flex-end',
                      height: 30,
                      padding: '0 14px',
                      borderRadius: 8,
                      border: 'none',
                      background: 'var(--accent-primary)',
                      color: 'var(--accent-primary-fg)',
                      fontSize: 12.5,
                      fontWeight: 500,
                    }}
                  >
                    Add MCP server
                  </button>
                </form>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {mcpServers.map((srv) => (
                    <div
                      key={srv.id}
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={srv.enabled}
                          onChange={(e) =>
                            void onSaveMcpServer({ ...srv, enabled: e.target.checked })
                          }
                          aria-label={`Enable MCP server ${srv.name}`}
                        />
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{srv.name}</span>
                        <span className="codex-pill mono" style={{ height: 20, fontSize: 10.5 }}>
                          {srv.transport}
                        </span>
                        <span
                          className="mono"
                          style={{
                            marginLeft: 'auto',
                            fontSize: 11,
                            color:
                              srv.lastStatus === 'ok'
                                ? 'var(--accent-green)'
                                : srv.lastStatus === 'error'
                                  ? 'var(--accent-red)'
                                  : 'var(--text-muted)',
                          }}
                        >
                          {srv.lastStatus === 'ok'
                            ? `${srv.tools?.length ?? 0} tools`
                            : srv.lastStatus ?? 'idle'}
                        </span>
                        <button
                          type="button"
                          className="pressable hover-surface"
                          onClick={() => void onTestMcpServer(srv.id)}
                          style={{
                            height: 26,
                            padding: '0 9px',
                            borderRadius: 6,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-surface)',
                            fontSize: 11.5,
                          }}
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          className="pressable hover-surface"
                          onClick={() => void onDeleteMcpServer(srv.id)}
                          aria-label={`Delete MCP server ${srv.name}`}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 6,
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--accent-red)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </div>
                      {srv.lastError && (
                        <div className="mono" style={{ fontSize: 11, color: 'var(--accent-red)' }}>
                          {srv.lastError}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {tab === 'voice' && (
              <>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Voice & Notifications</h2>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={draft.notifyOnComplete}
                    onChange={(e) => void applySettings({ notifyOnComplete: e.target.checked })}
                  />
                  <span>Desktop OS notifications when background tasks finish or need approval</span>
                </label>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={draft.soundOnComplete}
                      onChange={(e) => void applySettings({ soundOnComplete: e.target.checked })}
                    />
                    <span>Play completion chime</span>
                  </label>
                  <button
                    type="button"
                    className="pressable hover-surface"
                    onClick={playCompletionChime}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 7,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-surface)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 12,
                    }}
                  >
                    <Volume2 size={12} aria-hidden="true" />
                    <span>Test chime</span>
                  </button>
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>Local Whisper / STT Endpoint URL</span>
                  <input
                    type="url"
                    value={draft.sttEndpointUrl}
                    onChange={(e) => setDraft({ ...draft, sttEndpointUrl: e.target.value })}
                    placeholder="http://127.0.0.1:8000/v1/audio/transcriptions"
                    style={{
                      height: 34,
                      padding: '0 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-elevated)',
                    }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>STT Model Name</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={draft.sttModel}
                      onChange={(e) => setDraft({ ...draft, sttModel: e.target.value })}
                      style={{
                        flex: 1,
                        height: 34,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-elevated)',
                      }}
                    />
                    <button
                      type="button"
                      className="pressable codex-primary-btn"
                      onClick={() =>
                        void applySettings({
                          sttEndpointUrl: draft.sttEndpointUrl,
                          sttModel: draft.sttModel,
                        })
                      }
                      style={{
                        height: 34,
                        padding: '0 14px',
                        borderRadius: 8,
                        border: 'none',
                        background: 'var(--accent-primary)',
                        color: 'var(--accent-primary-fg)',
                        fontSize: 12.5,
                        fontWeight: 500,
                      }}
                    >
                      Save STT
                    </button>
                  </div>
                </label>
              </>
            )}

            {tab === 'shortcuts' && (
              <>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Keyboard Shortcuts</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {KEYBOARD_SHORTCUTS.map((sc) => (
                    <div
                      key={sc.keys}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-elevated)',
                        fontSize: 12.5,
                      }}
                    >
                      <span>{sc.action}</span>
                      <kbd
                        className="mono"
                        style={{
                          padding: '2px 8px',
                          borderRadius: 6,
                          border: '1px solid var(--border-default)',
                          background: 'var(--bg-surface)',
                          fontSize: 11,
                        }}
                      >
                        {sc.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
