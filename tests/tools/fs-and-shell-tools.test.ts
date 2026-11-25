import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoIndexer } from '../../electron/intel/repo-indexer';
import { TreeSitterService } from '../../electron/intel/tree-sitter-service';
import {
  extractCodePasteBlocks,
  StreamingCodeTagFilter,
} from '../../electron/tools/code-paste';
import {
  normalizeHashlineEdits,
  resolveInsideWorkdir,
  runCreateFile,
  runDeleteFile,
  runFindFiles,
  runListDir,
  runMoveFile,
  runPatchFile,
  runReadRange,
  runReadSymbol,
  runReplaceLineRange,
  runReplaceSymbolPaste,
  runWriteFilePaste,
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
    expect(patched.output).toContain('Updated lines');
    expect(patched.output).toMatch(/1:[0-9a-z]{2}\| updated outside/);
    expect(readFileSync(extFile, 'utf8')).toBe('updated outside\n');
  });

  it('extracts, filters, guards, and applies raw code-paste blocks (<file_write>, <replace_symbol>, <replace_range>)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-paste-'));
    cleanDirs.push(dir);
    const ts = new TreeSitterService();

    // Streaming filter hides raw code body from prose while emitting tag events
    const streamedProse: string[] = [];
    const startedTags: string[] = [];
    const filter = new StreamingCodeTagFilter(
      (delta) => streamedProse.push(delta),
      (info) => startedTags.push(`${info.kind}:${info.filePath}`),
    );
    const fullReply =
      'Updating file now.\n<file_write path="app.py">\n```python\ndef greet():\n    return "hi"\n```\n</file_write>\nDone.';
    for (let i = 0; i < fullReply.length; i += 7) {
      filter.push(fullReply.slice(i, i + 7));
    }
    filter.flush();
    expect(startedTags).toEqual(['file_write:app.py']);
    expect(streamedProse.join('')).toBe('Updating file now.\n\nDone.');

    // Extractor unwraps optional fenced block & detects truncated unclosed tags
    const extracted = extractCodePasteBlocks(fullReply);
    expect(extracted.blocks).toHaveLength(1);
    expect(extracted.blocks[0].content).toBe('def greet():\n    return "hi"');

    const truncated = extractCodePasteBlocks('<file_write path="app.py">\ndef broken():\n');
    expect(truncated.blocks[0].truncationError).toContain('Truncated <file_write>');

    // Write file via runWriteFilePaste, then update symbol & range cleanly
    const written = await runWriteFilePaste({
      workdir: dir,
      filePath: 'app.py',
      content: extracted.blocks[0].content,
      treeSitter: ts,
      readOnly: false,
    });
    expect(written.ok).toBe(true);
    expect(readFileSync(join(dir, 'app.py'), 'utf8')).toBe('def greet():\n    return "hi"\n');

    const indexer = new RepoIndexer(ts);
    const idx = await indexer.buildIndex('p-paste', dir);
    const symReplaced = await runReplaceSymbolPaste({
      workdir: dir,
      index: idx,
      indexer,
      filePath: 'app.py',
      symbolName: 'greet',
      content: 'def greet(name="world"):\n    return f"hi {name}"',
      treeSitter: ts,
      readOnly: false,
    });
    expect(symReplaced.ok).toBe(true);
    expect(symReplaced.output).toContain('Updated lines');
    expect(readFileSync(join(dir, 'app.py'), 'utf8')).toContain('name="world"');

    const rangeReplaced = await runReplaceLineRange({
      workdir: dir,
      filePath: 'app.py',
      startLine: 2,
      endLine: 2,
      content: '    return f"hello {name}"',
      treeSitter: ts,
      readOnly: false,
    });
    expect(rangeReplaced.ok).toBe(true);
    expect(readFileSync(join(dir, 'app.py'), 'utf8')).toContain('hello {name}');

    // Placeholder omission & shrink guards reject unsafe overwrites
    await expect(
      runWriteFilePaste({
        workdir: dir,
        filePath: 'app.py',
        content: '# ... existing code ...\ndef other():\n    pass\n',
        treeSitter: ts,
        readOnly: false,
      }),
    ).rejects.toThrow(/placeholder/i);

    writeFileSync(
      join(dir, 'big.py'),
      Array.from({ length: 60 }, (_, i) => `x_${i} = ${i}`).join('\n') + '\n',
      'utf8',
    );
    await expect(
      runWriteFilePaste({
        workdir: dir,
        filePath: 'big.py',
        content: 'x_0 = 0\n',
        treeSitter: ts,
        readOnly: false,
      }),
    ).rejects.toThrow(/shrinks the file/i);
  });

  it('normalizes startLine/endLine/range/newContent aliases, guards NaN read_range, and adds Windows cmd.exe hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-norm-'));
    cleanDirs.push(dir);
    writeFileSync(join(dir, 'app.py'), 'a = 1\nb = 2\nc = 3\n', 'utf8');

    const normalized = normalizeHashlineEdits([
      { op: 'replace_range', startLine: 2, endLine: 3, newContent: 'b = 20\nc = 30' },
      { range: 'L1-L2', text: 'a = 10\nb = 20' },
    ]);
    expect(normalized).toEqual([
      { op: 'replace_range', startAnchor: '2', endAnchor: '3', content: 'b = 20\nc = 30' },
      { op: 'replace_range', startAnchor: '1', endAnchor: '2', content: 'a = 10\nb = 20' },
    ]);

    const nanSlice = runReadRange(dir, 'app.py', Number.NaN, Number.NaN);
    expect(nanSlice.output).toContain('1:');
    expect(nanSlice.output).toContain('a = 1');

    if (process.platform === 'win32') {
      const cmdRes = await executeSandboxedCommand({
        command: 'cat app.py',
        cwd: dir,
      });
      expect(cmdRes.exitCode).not.toBe(0);
      expect(cmdRes.output).toContain('Windows cmd.exe hint');
    }
  });
});
