import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveWindowMaterial } from '../src/shared/theme-presets';
import { AutomationRunner } from './agent/automation-runner';
import { AgentOrchestrator } from './agent/orchestrator';
import { TreeSitterService } from './intel/tree-sitter-service';
import { registerIpcHandlers } from './ipc/handlers';
import { McpManager } from './mcp/mcp-manager';
import { OllamaClient } from './ollama/client';
import { VramScheduler } from './ollama/vram-scheduler';
import { SmolCodeStore } from './store/database';
import { SnapshotManager } from './store/snapshots';
import { PtyManager } from './terminal/pty-manager';

let mainWindow: BrowserWindow | null = null;
let store: SmolCodeStore | null = null;
let ptyManager: PtyManager | null = null;
let automations: AutomationRunner | null = null;
let mcpManager: McpManager | null = null;
let orchestratorRef: AgentOrchestrator | null = null;

function resolveAppIcon(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    join(process.resourcesPath ?? '', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    join(__dirname, '../../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
  ];
  return candidates.find((p) => existsSync(p));
}

function createWindow(): void {
  const settings = store?.getSettings();
  const themePref = settings?.theme ?? 'dark';
  nativeTheme.themeSource = themePref;
  const windowMat = resolveWindowMaterial(
    themePref,
    settings?.themePreset ?? 'obsidian',
    settings?.glassIntensity ?? 'subtle',
    nativeTheme.shouldUseDarkColors,
  );
  const iconPath = resolveAppIcon();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 380,
    minHeight: 540,
    title: 'SmolCode',
    ...(iconPath ? { icon: iconPath } : {}),
    ...(process.platform === 'win32' && windowMat.useAcrylic
      ? { backgroundMaterial: 'acrylic' as const }
      : {}),
    backgroundColor: windowMat.backgroundColor,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: windowMat.overlayColor,
      symbolColor: windowMat.symbolColor,
      height: 38,
    },
    webPreferences: {
      preload: existsSync(join(__dirname, '../preload/index.mjs'))
        ? join(__dirname, '../preload/index.mjs')
        : join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  if (process.env.SMOLCODE_SMOKE_EXIT === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const res = await mainWindow?.webContents.executeJavaScript(
              'JSON.stringify({ hasApi: Boolean(window.smolcode), rootChildren: document.querySelector("#root")?.children.length ?? 0, title: document.title })',
            );
            if (process.env.SMOLCODE_SMOKE_SCREENSHOT && mainWindow) {
              const img = await mainWindow.webContents.capturePage();
              const outPng = process.env.SMOLCODE_SMOKE_SCREENSHOT;
              mkdirSync(dirname(outPng), { recursive: true });
              writeFileSync(outPng, img.toPNG());
            }
            console.log('SMOKE_OK:', res);
            app.quit();
          } catch (err) {
            console.error('SMOKE_ERR:', err);
            app.exit(1);
          }
        })();
      }, 450);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.smolcode.app');
  }
  store = new SmolCodeStore(process.env.SMOLCODE_DB_PATH);
  const settings = store.getSettings();
  const snapshots = new SnapshotManager(store);
  const ollama = new OllamaClient(settings.ollamaBaseUrl);
  const scheduler = new VramScheduler(ollama);
  const treeSitter = new TreeSitterService();
  const mcp = new McpManager();
  mcpManager = mcp;
  const orchestrator = new AgentOrchestrator(
    store,
    snapshots,
    ollama,
    scheduler,
    treeSitter,
    mcp,
  );
  orchestratorRef = orchestrator;
  automations = new AutomationRunner(store, orchestrator);
  ptyManager = new PtyManager(
    (ptyId, data) => mainWindow?.webContents.send('smolcode:terminal-data', { ptyId, data }),
    (ptyId, code) => mainWindow?.webContents.send('smolcode:terminal-exit', { ptyId, code }),
  );

  registerIpcHandlers({
    getWindow: () => mainWindow,
    store,
    snapshots,
    ollama,
    scheduler,
    orchestrator,
    automations,
    ptyManager,
    mcp,
  });

  automations.start();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  ptyManager?.closeAll();
  automations?.stop();
  orchestratorRef?.dispose();
  void mcpManager?.closeAll();
  store?.close();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  orchestratorRef?.dispose();
  void mcpManager?.closeAll();
});
