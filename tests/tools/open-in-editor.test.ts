import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openTargetInEditor,
  type OpenInEditorDeps,
  type ShellAdapter,
  type SpawnSpec,
} from '../../electron/tools/open-in-editor';

const tempDirs: string[] = [];

function makeTempWorkspace(suffix = 'smolcode space dir'): { dir: string; file: string } {
  const base = mkdtempSync(join(tmpdir(), 'smolcode-open-test-'));
  tempDirs.push(base);
  const dir = join(base, suffix);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hello world.ts');
  writeFileSync(file, 'export const ok = true;\n', 'utf8');
  return { dir, file };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function createHarness(overrides?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existingPaths?: Set<string>;
  dirPaths?: Set<string>;
  pathMatches?: Record<string, string[]>;
}) {
  const spawned: SpawnSpec[] = [];
  const openPath = vi.fn(async (_p: string) => '');
  const showItemInFolder = vi.fn((_p: string) => {});
  const shell: ShellAdapter = { openPath, showItemInFolder };

  const existing = overrides?.existingPaths ?? new Set<string>();
  const dirs = overrides?.dirPaths ?? new Set<string>();

  const deps: Partial<OpenInEditorDeps> = {
    platform: overrides?.platform ?? 'win32',
    env: overrides?.env ?? { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
    existsSync: (p) => existing.has(p),
    statSync: (p) => ({ isDirectory: () => dirs.has(p) }),
    findInPath: async (cmd) => overrides?.pathMatches?.[cmd] ?? [],
    spawnDetached: async (spec) => {
      spawned.push(spec);
    },
  };

  return { spawned, openPath, showItemInFolder, shell, deps };
}

describe('openTargetInEditor', () => {
  it('prefers sibling Code.exe over code.cmd on Windows and passes directory with spaces as one argument', async () => {
    const { dir } = makeTempWorkspace('coding Q4 2026\\SmolCode');
    const resolvedDir = resolve(dir);
    const codeShim = 'C:\\Users\\Test\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code';
    const codeCmd = 'C:\\Users\\Test\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
    const codeExe = 'C:\\Users\\Test\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';

    const h = createHarness({
      platform: 'win32',
      existingPaths: new Set([resolvedDir, codeShim, codeCmd, codeExe]),
      dirPaths: new Set([resolvedDir]),
      pathMatches: { code: [codeShim, codeCmd] },
    });

    const res = await openTargetInEditor({
      targetPath: dir,
      editor: 'vscode',
      shell: h.shell,
      deps: h.deps,
    });

    expect(res).toEqual({ ok: true, message: 'Opened in VS Code' });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].command).toBe(codeExe);
    expect(h.spawned[0].args).toEqual([resolvedDir]);
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('quotes .cmd shim and target path with spaces via cmd.exe verbatim args when no .exe exists', async () => {
    const { dir } = makeTempWorkspace('coding Q4 2026\\SmolCode');
    const resolvedDir = resolve(dir);
    const customCmd = 'C:\\Tools\\code.cmd';

    const h = createHarness({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      existingPaths: new Set([resolvedDir, customCmd]),
      dirPaths: new Set([resolvedDir]),
      pathMatches: { code: [customCmd] },
    });

    const res = await openTargetInEditor({
      targetPath: dir,
      editor: 'vscode',
      shell: h.shell,
      deps: h.deps,
    });

    expect(res).toEqual({ ok: true, message: 'Opened in VS Code' });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toMatchObject({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${customCmd}" "${resolvedDir}""`],
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  });

  it('returns an error instead of opening File Explorer when an explicit editor is missing', async () => {
    const { dir } = makeTempWorkspace();
    const resolvedDir = resolve(dir);
    const h = createHarness({
      platform: 'win32',
      existingPaths: new Set([resolvedDir]),
      dirPaths: new Set([resolvedDir]),
    });

    const res = await openTargetInEditor({
      targetPath: dir,
      editor: 'cursor',
      shell: h.shell,
      deps: h.deps,
    });

    expect(res.ok).toBe(false);
    expect(res.message).toContain('Cursor was not found');
    expect(h.openPath).not.toHaveBeenCalled();
    expect(h.spawned).toHaveLength(0);
  });

  it('falls back to File Explorer in auto mode when no editor is installed', async () => {
    const { dir } = makeTempWorkspace();
    const resolvedDir = resolve(dir);
    const h = createHarness({
      platform: 'win32',
      existingPaths: new Set([resolvedDir]),
      dirPaths: new Set([resolvedDir]),
    });

    const res = await openTargetInEditor({
      targetPath: dir,
      editor: 'auto',
      shell: h.shell,
      deps: h.deps,
    });

    expect(res).toEqual({ ok: true, message: 'Opened in File Explorer' });
    expect(h.openPath).toHaveBeenCalledWith(resolvedDir);
  });

  it('reveals files in File Explorer via showItemInFolder instead of launching them', async () => {
    const { file } = makeTempWorkspace();
    const resolvedFile = resolve(file);
    const h = createHarness({
      platform: 'win32',
      existingPaths: new Set([resolvedFile]),
      dirPaths: new Set(),
    });

    const res = await openTargetInEditor({
      targetPath: file,
      editor: 'explorer',
      shell: h.shell,
      deps: h.deps,
    });

    expect(res).toEqual({ ok: true, message: 'Revealed in File Explorer' });
    expect(h.showItemInFolder).toHaveBeenCalledWith(resolvedFile);
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('opens External Terminal using Windows Terminal (wt.exe) when installed and uses dirname for files', async () => {
    const { file } = makeTempWorkspace();
    const resolvedFile = resolve(file);
    const expectedCwd = dirname(resolvedFile);
    const wtExe = 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';

    const h = createHarness({
      platform: 'win32',
      existingPaths: new Set([resolvedFile, wtExe]),
      dirPaths: new Set(),
      pathMatches: { 'wt.exe': [wtExe] },
    });

    const res = await openTargetInEditor({
      targetPath: file,
      editor: 'terminal',
      defaultShell: 'auto',
      shell: h.shell,
      deps: h.deps,
    });

    expect(res).toEqual({ ok: true, message: 'Opened in External Terminal' });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toMatchObject({
      command: wtExe,
      args: ['-d', expectedCwd],
    });
  });

  it('returns an error when target path does not exist', async () => {
    const h = createHarness({ platform: 'win32' });
    const res = await openTargetInEditor({
      targetPath: 'C:\\definitely\\missing\\workspace dir',
      editor: 'vscode',
      shell: h.shell,
      deps: h.deps,
    });

    expect(res.ok).toBe(false);
    expect(res.message).toContain('Target path does not exist');
  });
});
