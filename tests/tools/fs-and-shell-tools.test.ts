import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoIndexer } from '../../electron/intel/repo-indexer';
import { TreeSitterService } from '../../electron/intel/tree-sitter-service';
import {
  resolveInsideWorkdir,
  runCreateFile,
  runDeleteFile,
  runFindFiles,
  runListDir,
  runMoveFile,
  runPatchFile,
  runReadRange,
  runReadSymbol,
} from '../../electron/tools/fs-tools';
import { commandNeedsApproval, executeSandboxedCommand } from '../../electron/tools/shell-tools';
import { MUTATING_TOOLS, READ_ONLY_TOOLS } from '../../electron/tools/tool-registry';
import { detectChecksForWorkspace } from '../../electron/tools/verify-gate';

const cleanDirs: string[] = [];

afterEach(() => {
  while (cleanDirs.length > 0) {
    const d = cleanDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('Workspace FS tools, hashline anchors, and streaming shell', () => {
  it('exposes patch_hashline, list_dir, find_files, delete_file, move_file, and web_lookup in tool registry', () => {
    const readNames = READ_ONLY_TOOLS.map((t) => t.function.name);
    const mutNames = MUTATING_TOOLS.map((t) => t.function.name);

    expect(readNames).toEqual(
      expect.arrayContaining(['list_dir', 'find_files', 'repo_search', 'read_symbol', 'read_range', 'web_lookup']),
    );
    expect(mutNames).toEqual(
      expect.arrayContaining(['patch_hashline', 'patch_file', 'create_file', 'delete_file', 'move_file', 'run_command']),
    );
  });

  it('lists dirs, finds non-code assets, returns line:hash| anchors, and moves/deletes safely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-fstools-'));
    cleanDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });

    writeFileSync(
      join(dir, 'src/demo.ts'),
      'export function greet(name: string) {\n  return `hi ${name}`;\n}\n',
      'utf8',
    );
    writeFileSync(join(dir, 'assets/logo.svg'), '<svg></svg>\n', 'utf8');
    writeFileSync(join(dir, 'node_modules/pkg/ignored.ts'), 'export const x = 1;\n', 'utf8');

    const tree = runListDir(dir, '.', 2);
    expect(tree).toContain('src/');
    expect(tree).toContain('demo.ts');
    expect(tree).not.toContain('node_modules');

    const svgFiles = runFindFiles(dir, '*.svg');
    expect(svgFiles).toBe('assets/logo.svg');

    const range = runReadRange(dir, 'src/demo.ts', 1, 3);
    expect(range.output).toMatch(/1:[0-9a-z]{2}\| export function greet/);
    expect(range.output).toMatch(/2:[0-9a-z]{2}\| {3}return `hi \$\{name\}`;/);

    const indexer = new RepoIndexer(new TreeSitterService());
    const idx = await indexer.buildIndex('p-fs', dir);
    const sym = runReadSymbol(idx, indexer, 'src/demo.ts', 'greet');
    expect(sym.output).toMatch(/1:[0-9a-z]{2}\| export function greet/);

    // Read-only blocks delete/move
    expect(() => runDeleteFile({ workdir: dir, filePath: 'assets/logo.svg', readOnly: true })).toThrow(/read-only/i);
    expect(() =>
      runMoveFile({ workdir: dir, fromPath: 'assets/logo.svg', toPath: 'assets/icon.svg', readOnly: true }),
    ).toThrow(/read-only/i);

    // Move and delete inside workspace work cleanly
    const moved = runMoveFile({
      workdir: dir,
      fromPath: 'assets/logo.svg',
      toPath: 'assets/icon.svg',
      readOnly: false,
    });
    expect(moved.toRel).toBe('assets/icon.svg');
    expect(existsSync(join(dir, 'assets/icon.svg'))).toBe(true);
    expect(existsSync(join(dir, 'assets/logo.svg'))).toBe(false);

    const deleted = runDeleteFile({ workdir: dir, filePath: 'assets/icon.svg', readOnly: false });
    expect(deleted.relPath).toBe('assets/icon.svg');
    expect(existsSync(join(dir, 'assets/icon.svg'))).toBe(false);
    expect(() => runDeleteFile({ workdir: dir, filePath: '../outside.txt', readOnly: false })).toThrow(/outside/i);
  });

  it('streams stdout chunks during executeSandboxedCommand and supports AbortSignal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-shell-'));
    cleanDirs.push(dir);

    const chunks: string[] = [];
    const res = await executeSandboxedCommand({
      command: `node -e "console.log('line-one'); setTimeout(() => { console.log('line-two'); }, 60);"`,
      cwd: dir,
      onOutputChunk: (text) => chunks.push(text),
    });

    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('line-one');
    expect(res.output).toContain('line-two');
    expect(chunks.length).toBeGreaterThan(0);

    // AbortSignal terminates promptly
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const aborted = await executeSandboxedCommand({
      command: `node -e "setInterval(() => {}, 1000)"`,
      cwd: dir,
      signal: ac.signal,
    });
    expect(aborted.exitCode).not.toBe(0);
    expect(aborted.output.toLowerCase()).toContain('abort');

    // Read-only patterns allow rg/node -v without git assumptions
    expect(commandNeedsApproval('rg foo src', 'read-only', new Set())).toBe('allow');
    expect(commandNeedsApproval('node -v', 'read-only', new Set())).toBe('allow');
    expect(commandNeedsApproval('git status', 'read-only', new Set())).toBe('deny');
  });

  it('detects lint and targeted Vitest tests in verify-gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-vgate-'));
    cleanDirs.push(dir);
    mkdirSync(join(dir, 'tests'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'vitest run',
        },
      }),
      'utf8',
    );
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'src/hashline.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(dir, 'tests/hashline.test.ts'), 'export {};\n', 'utf8');

    const checks = detectChecksForWorkspace(dir, 'typecheck+tests', ['src/hashline.ts']);
    expect(checks.map((c) => c.label)).toEqual(['typecheck', 'lint', 'targeted tests']);
    expect(checks[2].command).toContain('tests/hashline.test.ts');
    expect(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).toBe('{}');
  });

  it('expands ~/ paths and gates outside-root writes behind allowOutsideRoot', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'smolcode-ws-'));
    const extDir = mkdtempSync(join(tmpdir(), 'smolcode-ext-'));
    cleanDirs.push(workdir, extDir);

    const tilde = resolveInsideWorkdir(workdir, '~/notes/todo.txt');
    expect(tilde.absPath).toBe(join(homedir(), 'notes/todo.txt'));
    expect(tilde.inside).toBe(false);

    const extFile = join(extDir, 'outside.txt');
    const ts = new TreeSitterService();

    // Still refused at fs-tools layer when allowOutsideRoot is omitted
    await expect(
      runCreateFile({
        workdir,
        filePath: extFile,
        content: 'blocked\n',
        treeSitter: ts,
        readOnly: false,
      }),
    ).rejects.toThrow(/outside active workspace/i);

    // Succeeds once orchestrator approval passes allowOutsideRoot: true
    const created = await runCreateFile({
      workdir,
      filePath: extFile,
      content: 'hello outside\n',
      treeSitter: ts,
      readOnly: false,
      allowOutsideRoot: true,
    });
    expect(created.inside).toBe(false);
    expect(created.absPath).toBe(extFile);
    expect(readFileSync(extFile, 'utf8')).toBe('hello outside\n');

    const patched = await runPatchFile({
      workdir,
      filePath: extFile,
      oldText: 'hello outside',
      newText: 'updated outside',
      treeSitter: ts,
      readOnly: false,
      allowOutsideRoot: true,
    });
    expect(patched.ok).toBe(true);
    expect(readFileSync(extFile, 'utf8')).toBe('updated outside\n');
  });
});
