import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AppSettings, PreferredEditor } from '../../src/shared/types';
import { resolveWindowsShell } from '../terminal/pty-manager';

const execFileAsync = promisify(execFile);

export interface ShellAdapter {
  openPath(targetPath: string): Promise<string>;
  showItemInFolder(targetPath: string): void;
}

export interface OpenTargetResult {
  ok: boolean;
  message?: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  windowsVerbatimArguments?: boolean;
  windowsHide?: boolean;
}

export interface OpenInEditorDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory: () => boolean };
  findInPath: (cmd: string) => Promise<string[]>;
  spawnDetached: (spec: SpawnSpec) => Promise<void>;
  shell: ShellAdapter;
}

type ConcreteEditor = 'vscode' | 'cursor' | 'windsurf';

interface EditorDefinition {
  id: ConcreteEditor;
  name: string;
  cliCommands: string[];
  winExeNames: string[];
  winInstallDirs: (env: NodeJS.ProcessEnv) => string[];
  macAppPaths: string[];
}

const EDITOR_DEFINITIONS: Record<ConcreteEditor, EditorDefinition> = {
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    cliCommands: ['cursor'],
    winExeNames: ['Cursor.exe'],
    winInstallDirs: (env) =>
      compactPaths([
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'cursor') : '',
        env.ProgramFiles ? join(env.ProgramFiles, 'cursor') : '',
        env.ProgramFiles ? join(env.ProgramFiles, 'Cursor') : '',
      ]),
    macAppPaths: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
  },
  vscode: {
    id: 'vscode',
    name: 'VS Code',
    cliCommands: ['code'],
    winExeNames: ['Code.exe'],
    winInstallDirs: (env) =>
      compactPaths([
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code') : '',
        env.ProgramFiles ? join(env.ProgramFiles, 'Microsoft VS Code') : '',
        env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Microsoft VS Code') : '',
      ]),
    macAppPaths: [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    ],
  },
  windsurf: {
    id: 'windsurf',
    name: 'Windsurf',
    cliCommands: ['windsurf'],
    winExeNames: ['Windsurf.exe'],
    winInstallDirs: (env) =>
      compactPaths([
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Windsurf') : '',
        env.ProgramFiles ? join(env.ProgramFiles, 'Windsurf') : '',
      ]),
    macAppPaths: ['/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'],
  },
};

function compactPaths(paths: string[]): string[] {
  return paths.filter(Boolean);
}

function quoteCmdArg(value: string): string {
  const sanitized = value.replace(/"/g, '');
  return `"${sanitized}"`;
}

function buildWindowsCmdLaunch(
  cmdPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): SpawnSpec {
  const commandLine = [quoteCmdArg(cmdPath), ...args.map(quoteCmdArg)].join(' ');
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
    windowsHide: true,
  };
}

async function defaultFindInPath(cmd: string, platform: NodeJS.Platform): Promise<string[]> {
  const tool = platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(tool, [cmd], {
      windowsHide: true,
      timeout: 3000,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function defaultSpawnDetached(spec: SpawnSpec, env: NodeJS.ProcessEnv): Promise<void> {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.VSCODE_DEV;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: childEnv,
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: spec.windowsHide ?? true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });

    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    });

    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolvePromise();
      }
    });
  });
}

function createDefaultDeps(shell: ShellAdapter): OpenInEditorDeps {
  return {
    platform: process.platform,
    env: process.env,
    existsSync,
    statSync,
    findInPath: (cmd) => defaultFindInPath(cmd, process.platform),
    spawnDetached: (spec) => defaultSpawnDetached(spec, process.env),
    shell,
  };
}

function pickWindowsExecutable(
  candidates: string[],
  winExeNames: string[],
  deps: OpenInEditorDeps,
): string | null {
  const exeMatch = candidates.find((p) => /\.exe$/i.test(p) && deps.existsSync(p));
  if (exeMatch) return exeMatch;

  const cmdMatches = candidates.filter((p) => /\.(cmd|bat)$/i.test(p) && deps.existsSync(p));
  for (const cmdPath of cmdMatches) {
    const parent = dirname(dirname(cmdPath));
    for (const exeName of winExeNames) {
      const siblingExe = join(parent, exeName);
      if (deps.existsSync(siblingExe)) return siblingExe;
    }
  }
  return cmdMatches[0] ?? null;
}

async function resolveEditorExecutable(
  editorId: ConcreteEditor,
  deps: OpenInEditorDeps,
): Promise<string | null> {
  const def = EDITOR_DEFINITIONS[editorId];

  for (const cli of def.cliCommands) {
    const found = await deps.findInPath(cli);
    if (deps.platform === 'win32') {
      const winResolved = pickWindowsExecutable(found, def.winExeNames, deps);
      if (winResolved) return winResolved;
    } else {
      const match = found.find((p) => deps.existsSync(p));
      if (match) return match;
    }
  }

  if (deps.platform === 'win32') {
    for (const dir of def.winInstallDirs(deps.env)) {
      for (const exeName of def.winExeNames) {
        const exePath = join(dir, exeName);
        if (deps.existsSync(exePath)) return exePath;
      }
    }
  } else if (deps.platform === 'darwin') {
    for (const appCli of def.macAppPaths) {
      if (deps.existsSync(appCli)) return appCli;
    }
  }

  return null;
}

async function openInExplorer(
  resolvedPath: string,
  isDirectory: boolean,
  deps: OpenInEditorDeps,
): Promise<OpenTargetResult> {
  if (!isDirectory) {
    deps.shell.showItemInFolder(resolvedPath);
    return { ok: true, message: 'Revealed in File Explorer' };
  }
  const err = await deps.shell.openPath(resolvedPath);
  return err ? { ok: false, message: err } : { ok: true, message: 'Opened in File Explorer' };
}

async function resolveWindowsTerminal(deps: OpenInEditorDeps): Promise<string | null> {
  const fromPath = await deps.findInPath('wt.exe');
  const pathMatch = fromPath.find((p) => /\.exe$/i.test(p) && deps.existsSync(p));
  if (pathMatch) return pathMatch;

  const localAppData = deps.env.LOCALAPPDATA;
  if (localAppData) {
    const standardWt = join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
    if (deps.existsSync(standardWt)) return standardWt;
  }
  return null;
}

async function openInExternalTerminal(
  cwd: string,
  defaultShell: AppSettings['defaultShell'],
  deps: OpenInEditorDeps,
): Promise<OpenTargetResult> {
  if (deps.platform === 'win32') {
    const wtPath = await resolveWindowsTerminal(deps);
    if (wtPath) {
      if (defaultShell === 'auto') {
        await deps.spawnDetached({ command: wtPath, args: ['-d', cwd], windowsHide: true });
      } else {
        const resolved = resolveWindowsShell(defaultShell);
        await deps.spawnDetached({
          command: wtPath,
          args: ['-d', cwd, resolved.shell, ...resolved.args],
          windowsHide: true,
        });
      }
      return { ok: true, message: 'Opened in External Terminal' };
    }

    const resolved = resolveWindowsShell(defaultShell);
    await deps.spawnDetached({
      command: resolved.shell,
      args: resolved.args,
      cwd,
      windowsHide: false,
    });
    return { ok: true, message: `Opened in ${resolved.label}` };
  }

  if (deps.platform === 'darwin') {
    await deps.spawnDetached({
      command: 'open',
      args: ['-a', 'Terminal', cwd],
    });
    return { ok: true, message: 'Opened in Terminal' };
  }

  const linuxTerms = [
    { cmd: 'x-terminal-emulator', args: [] as string[] },
    { cmd: 'gnome-terminal', args: ['--working-directory', cwd] },
    { cmd: 'konsole', args: ['--workdir', cwd] },
    { cmd: 'xfce4-terminal', args: ['--working-directory', cwd] },
    { cmd: 'kitty', args: ['--directory', cwd] },
    { cmd: 'alacritty', args: ['--working-directory', cwd] },
    { cmd: 'wezterm', args: ['start', '--cwd', cwd] },
  ];
  for (const term of linuxTerms) {
    const found = await deps.findInPath(term.cmd);
    const exe = found.find((p) => deps.existsSync(p));
    if (exe) {
      await deps.spawnDetached({ command: exe, args: term.args, cwd });
      return { ok: true, message: 'Opened in External Terminal' };
    }
  }

  const err = await deps.shell.openPath(cwd);
  return err ? { ok: false, message: err } : { ok: true, message: 'Opened directory' };
}

async function launchEditor(
  editorId: ConcreteEditor,
  resolvedPath: string,
  deps: OpenInEditorDeps,
): Promise<OpenTargetResult | null> {
  const exePath = await resolveEditorExecutable(editorId, deps);
  if (!exePath) return null;

  const isWinShim = deps.platform === 'win32' && /\.(cmd|bat)$/i.test(exePath);
  const spec: SpawnSpec = isWinShim
    ? buildWindowsCmdLaunch(exePath, [resolvedPath], deps.env)
    : { command: exePath, args: [resolvedPath], windowsHide: true };

  await deps.spawnDetached(spec);
  return { ok: true, message: `Opened in ${EDITOR_DEFINITIONS[editorId].name}` };
}

/**
 * Opens a workspace directory or file in the selected editor, File Explorer, or external terminal.
 * Uses direct `.exe` invocation or verbatim-quoted `cmd.exe` arguments on Windows so paths with
 * spaces are never split into separate file arguments.
 */
export async function openTargetInEditor(params: {
  targetPath: string;
  editor: PreferredEditor;
  defaultShell?: AppSettings['defaultShell'];
  shell: ShellAdapter;
  deps?: Partial<OpenInEditorDeps>;
}): Promise<OpenTargetResult> {
  const { targetPath, editor, defaultShell = 'auto', shell } = params;
  if (!targetPath || !targetPath.trim()) {
    return { ok: false, message: 'No target path' };
  }

  const deps: OpenInEditorDeps = { ...createDefaultDeps(shell), ...params.deps };
  const resolvedPath = resolve(targetPath);
  if (!deps.existsSync(resolvedPath)) {
    return { ok: false, message: `Target path does not exist: ${resolvedPath}` };
  }

  let isDirectory: boolean;
  try {
    isDirectory = deps.statSync(resolvedPath).isDirectory();
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    if (editor === 'explorer') {
      return await openInExplorer(resolvedPath, isDirectory, deps);
    }
    if (editor === 'terminal') {
      const cwd = isDirectory ? resolvedPath : dirname(resolvedPath);
      return await openInExternalTerminal(cwd, defaultShell, deps);
    }

    const candidates: ConcreteEditor[] =
      editor === 'auto' ? ['cursor', 'vscode', 'windsurf'] : [editor];

    for (const candidate of candidates) {
      const launched = await launchEditor(candidate, resolvedPath, deps);
      if (launched) return launched;
    }

    if (editor === 'auto') {
      return await openInExplorer(resolvedPath, isDirectory, deps);
    }

    const label = EDITOR_DEFINITIONS[editor].name;
    return {
      ok: false,
      message: `${label} was not found on PATH or in standard install folders.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
