import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAstRepoSkeleton, rankFilesWithPageRank } from '../../electron/intel/ast-repo-map';
import { RepoIndexer } from '../../electron/intel/repo-indexer';
import { TreeSitterService } from '../../electron/intel/tree-sitter-service';
import { SmolCodeStore } from '../../electron/store/database';

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Tree-sitter AST indexer & PageRank repo map', () => {
  it('parses TS symbols, catches syntax errors, caches in SQLite, and ranks seeded files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-ast-'));
    cleanupDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });

    writeFileSync(
      join(dir, 'src/math.ts'),
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    );
    writeFileSync(
      join(dir, 'src/app.ts'),
      "import { add } from './math';\nexport function run() {\n  return add(1, 2);\n}\n",
    );
    writeFileSync(
      join(dir, 'src/unrelated.ts'),
      'export const VERSION = "1.0";\n',
    );

    const store = new SmolCodeStore(':memory:');
    const ts = new TreeSitterService();
    const indexer = new RepoIndexer(ts, store);

    const index = await indexer.buildIndex('proj-1', dir);
    expect(index.files.get('src/math.ts')?.symbols[0]?.name).toBe('add');
    expect(index.adjacency.get('src/app.ts')?.has('src/math.ts')).toBe(true);

    const ranked = rankFilesWithPageRank(index, ['src/app.ts']);
    expect(ranked[0].relPath).toBe('src/app.ts');
    expect(ranked[1].relPath).toBe('src/math.ts');

    const map = buildAstRepoSkeleton(index, ['src/app.ts'], 2000);
    expect(map.skeleton).toContain('function add [L1-3]');

    const issues = await ts.checkSyntaxErrors('bad.ts', 'export function x( { return 1;');
    expect(issues.length).toBeGreaterThan(0);

    // Second build reuses SQLite ast_cache cleanly and preserves cached lineCount
    const cachedRows = store.getAstCache('proj-1');
    expect(cachedRows.length).toBe(3);
    expect(cachedRows.find((r) => r.filePath === 'src/math.ts')?.lineCount).toBe(4);

    const indexer2 = new RepoIndexer(ts, store);
    const index2 = await indexer2.buildIndex('proj-1', dir);
    expect(index2.files.get('src/math.ts')?.lineCount).toBe(4);
    expect(index2.files.get('src/app.ts')?.lineCount).toBe(5);

    // Structural dirty tracking increments structure version
    const v0 = indexer2.getStructureVersion(dir);
    indexer2.markDirty(dir, 'src/new.ts', true);
    expect(indexer2.getStructureVersion(dir)).toBe(v0 + 1);

    indexer.closeAllWatchers();
    indexer2.closeAllWatchers();
    store.close();
  });
});
