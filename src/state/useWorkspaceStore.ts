import { useCallback, useEffect, useState } from 'react';
import { THEME_PRESETS } from '../shared/theme-presets';
import type {
  AppSettings,
  AutomationRule,
  CenterView,
  McpServerConfig,
  OllamaModelInfo,
  ProjectRecord,
  SettingsTab,
  SkillEntry,
  ThreadRecord,
  VramStatus,
} from '../shared/types';
import { DEFAULT_APP_SETTINGS } from './defaults';

export function useWorkspaceStore() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [vram, setVram] = useState<VramStatus>({
    totalMb: 0,
    freeMb: 0,
    loadedModels: [],
  });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [automations, setAutomations] = useState<AutomationRule[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);

  const [centerView, setCenterView] = useState<CenterView>('thread');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(268);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(230);
  const [miniWindow, setMiniWindow] = useState(false);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);

  const showToast = useCallback(
    (message: string, action?: { label: string; onAction: () => void }) => {
      const id = Date.now() + Math.random();
      setToast({
        id,
        message,
        actionLabel: action?.label,
        onAction: action?.onAction,
      });
      const ttl = action ? 8500 : 3000;
      setTimeout(() => {
        setToast((curr) => (curr?.id === id ? null : curr));
      }, ttl);
    },
    [],
  );

  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const activeProject = activeThread
    ? projects.find((p) => p.id === activeThread.projectId) ?? null
    : projects[0] ?? null;

  const resolvedTheme: 'light' | 'dark' =
    settings.theme === 'system'
      ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : settings.theme;

  const presetMeta = THEME_PRESETS.find((p) => p.id === settings.themePreset);
  const resolvedPreset =
    presetMeta && presetMeta.base === resolvedTheme
      ? presetMeta.id
      : resolvedTheme === 'light'
        ? 'alabaster'
        : 'obsidian';

  useEffect(() => {
    const el = document.documentElement;
    const glassMode = settings.glassIntensity ?? 'subtle';
    const acrylicActive = glassMode !== 'off' && resolvedPreset !== 'high-contrast';
    el.setAttribute('data-theme', resolvedTheme);
    el.setAttribute('data-preset', resolvedPreset);
    el.setAttribute('data-accent', settings.accentColor ?? 'blue');
    el.setAttribute('data-density', settings.uiDensity ?? 'comfortable');
    el.setAttribute('data-font-size', settings.fontSize ?? 'md');
    el.setAttribute('data-glass', glassMode);
    el.setAttribute('data-acrylic', String(acrylicActive));
    el.setAttribute('data-reduce-motion', String(Boolean(settings.reduceMotion)));
  }, [
    resolvedTheme,
    resolvedPreset,
    settings.accentColor,
    settings.uiDensity,
    settings.fontSize,
    settings.glassIntensity,
    settings.reduceMotion,
  ]);

  useEffect(() => {
    document.documentElement.setAttribute('data-mini-window', String(miniWindow));
  }, [miniWindow]);

  const hydrateModels = useCallback(
    (loadedSettings: AppSettings, catalog: OllamaModelInfo[]) => {
      setModels(catalog);
      if (catalog.length > 0 && !loadedSettings.defaultMainModel) {
        const first = catalog[0].name;
        const patch = {
          defaultMainModel: first,
          defaultFastModel: loadedSettings.defaultFastModel || first,
        };
        setSettings((prev) => ({ ...prev, ...patch }));
        void window.smolcode?.updateSettings(patch);
      }
    },
    [],
  );

  const refreshAll = useCallback(async () => {
    if (!window.smolcode) return;
    const [loadedSettings, loadedProjects, loadedThreads] = await Promise.all([
      window.smolcode.getSettings(),
      window.smolcode.listProjects(),
      window.smolcode.listThreads(),
    ]);
    setSettings(loadedSettings);
    setProjects(loadedProjects);
    setThreads(loadedThreads);
    setActiveThreadId((prev) => {
      if (prev && loadedThreads.some((t) => t.id === prev)) return prev;
      return loadedThreads.find((t) => !t.archived)?.id ?? loadedThreads[0]?.id ?? null;
    });

    void window.smolcode
      .listOllamaModels()
      .then((catalog) => hydrateModels(loadedSettings, catalog))
      .catch(() => {});
    void window.smolcode.getVramStatus().then(setVram).catch(() => {});
    void window.smolcode.listSkills(loadedProjects[0]?.id).then(setSkills).catch(() => {});
    void window.smolcode.listAutomations().then(setAutomations).catch(() => {});
    void window.smolcode.listMcpServers().then(setMcpServers).catch(() => {});
  }, [hydrateModels]);

  useEffect(() => {
    if (!window.smolcode) return;
    let cancelled = false;
    void (async () => {
      const [loadedSettings, loadedProjects, loadedThreads] = await Promise.all([
        window.smolcode.getSettings(),
        window.smolcode.listProjects(),
        window.smolcode.listThreads(),
      ]);
      if (cancelled) return;
      setSettings(loadedSettings);
      setProjects(loadedProjects);
      setThreads(loadedThreads);
      setActiveThreadId((prev) => {
        if (prev && loadedThreads.some((t) => t.id === prev)) return prev;
        return loadedThreads.find((t) => !t.archived)?.id ?? loadedThreads[0]?.id ?? null;
      });
      void window.smolcode
        .listOllamaModels()
        .then((m) => !cancelled && hydrateModels(loadedSettings, m))
        .catch(() => {});
      void window.smolcode.getVramStatus().then((v) => !cancelled && setVram(v)).catch(() => {});
      void window.smolcode
        .listSkills(loadedProjects[0]?.id)
        .then((s) => !cancelled && setSkills(s))
        .catch(() => {});
      void window.smolcode
        .listAutomations()
        .then((a) => !cancelled && setAutomations(a))
        .catch(() => {});
      void window.smolcode
        .listMcpServers()
        .then((m) => !cancelled && setMcpServers(m))
        .catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateModels]);

  useEffect(() => {
    if (!activeThreadId || !window.smolcode) return;
    const pid = activeThread?.projectId;
    if (pid) {
      void window.smolcode.listSkills(pid).then(setSkills).catch(() => {});
    }
  }, [activeThread?.projectId, activeThreadId]);

  useEffect(() => {
    if (!window.smolcode) return;
    return window.smolcode.onAgentEvent((ev) => {
      if (ev.type === 'skills_updated') {
        setSkills(ev.skills);
      }
    });
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.smolcode.updateSettings(patch);
    setSettings(next);
    return next;
  }, []);

  const pickAndOpenProject = useCallback(async () => {
    const project = await window.smolcode.pickProjectFolder();
    if (!project) return null;
    setProjects((prev) =>
      prev.some((p) => p.id === project.id) ? prev : [...prev, project],
    );
    const created = await window.smolcode.createThread({ projectId: project.id });
    setThreads((prev) => [created, ...prev]);
    setActiveThreadId(created.id);
    setCenterView('thread');
    return project;
  }, []);

  const removeProject = useCallback(async (projectId: string) => {
    await window.smolcode.removeProject(projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setThreads((prev) => {
      const next = prev.filter((t) => t.projectId !== projectId);
      setActiveThreadId((curr) =>
        curr && next.some((t) => t.id === curr) ? curr : next[0]?.id ?? null,
      );
      return next;
    });
  }, []);

  const createThread = useCallback(
    async (
      projectId: string,
      opts?: { interactionMode?: ThreadRecord['interactionMode'] },
    ) => {
      const created = await window.smolcode.createThread({
        projectId,
        interactionMode: opts?.interactionMode,
      });
      setThreads((prev) => [created, ...prev]);
      setActiveThreadId(created.id);
      setCenterView('thread');
      return created;
    },
    [],
  );

  const updateThread = useCallback(
    async (threadId: string, patch: Partial<ThreadRecord>) => {
      const updated = await window.smolcode.updateThread(threadId, patch);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? updated : t)));
      return updated;
    },
    [],
  );

  const deleteThread = useCallback(async (threadId: string) => {
    await window.smolcode.deleteThread(threadId);
    setThreads((prev) => {
      const next = prev.filter((t) => t.id !== threadId);
      setActiveThreadId((curr) =>
        curr === threadId ? next.find((t) => !t.archived)?.id ?? null : curr,
      );
      return next;
    });
  }, []);

  const selectThread = useCallback(async (threadId: string) => {
    setActiveThreadId(threadId);
    setCenterView('thread');
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, unread: false } : t)),
    );
    try {
      await window.smolcode.updateThread(threadId, { unread: false });
    } catch {
      // Ignore transient update failure
    }
  }, []);

  const refreshVram = useCallback(async () => {
    if (!window.smolcode) return;
    try {
      setVram(await window.smolcode.getVramStatus());
    } catch {
      // Ignore probe error
    }
  }, []);

  const toggleMiniMode = useCallback(async () => {
    const next = !miniWindow;
    setMiniWindow(next);
    if (next) {
      setSidebarOpen(false);
    } else {
      setSidebarOpen(true);
    }
    try {
      await window.smolcode?.toggleMiniWindow(next);
    } catch {
      // Ignore in web preview
    }
  }, [miniWindow]);

  return {
    settings,
    resolvedTheme,
    resolvedPreset,
    models,
    vram,
    projects,
    threads,
    activeThread,
    activeProject,
    activeThreadId,
    skills,
    automations,
    mcpServers,
    centerView,
    settingsTab,
    sidebarOpen,
    sidebarWidth,
    terminalOpen,
    terminalHeight,
    miniWindow,
    paletteOpen,
    shortcutsOpen,
    toast,
    dismissToast,
    setCenterView,
    setSettingsTab,
    setSidebarOpen,
    setSidebarWidth,
    setTerminalOpen,
    setTerminalHeight,
    setPaletteOpen,
    setShortcutsOpen,
    setProjects,
    setThreads,
    setSkills,
    setAutomations,
    setMcpServers,
    setModels,
    showToast,
    updateSettings,
    pickAndOpenProject,
    removeProject,
    createThread,
    updateThread,
    deleteThread,
    selectThread,
    refreshVram,
    refreshAll,
    toggleMiniMode,
  };
}
