import { createHash } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';
import type { SearchSuggestion } from '../../src/shared/types';
import type { SmolCodeStore } from '../store/database';
import type { AstSymbol, TreeSitterService } from './tree-sitter-service';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.smolcode',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.turbo',
  '__pycache__',
  '.venv',
  'coverage',
]);

const INDEXABLE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.css',
  '.html',
  '.json',
  '.md',
  '.toml',
  '.yaml',
  '.yml',
]);

export interface IndexedFile {
  relPath: string;
  mtimeMs: number;
  symbols: AstSymbol[];
  imports: string[];
  lineCount: number;
}

export interface RepoIndex {
  projectId: string;
  workdir: string;
  files: Map<string, IndexedFile>;
  adjacency: Map<string, Set<string>>;
  reverseAdj: Map<string, Set<string>>;
}

async function loadGitIgnorePrefixes(rootDir: string): Promise<Set<string>> {
  const gitIgnorePath = join(rootDir, '.gitignore');
  const patterns = new Set<string>();
  if (!existsSync(gitIgnorePath)) return patterns;
  try {
    const raw = await readFile(gitIgnorePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('!')) continue;
      patterns.add(cleaned.replace(/^\/+/, '').replace(/\/+$/, ''));
    }
  } catch {
    // Ignore unreadable .gitignore
  }
  return patterns;
}

async function scanIndexableFilesAsync(
  rootDir: string,
  ignorePrefixes: Set<string>,
  currentDir = rootDir,
  acc: string[] = [],
): Promise<string[]> {
  if (acc.length >= 2500) return acc;
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (acc.length >= 2500) break;
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentDir, entry.name);
    const rel = relative(rootDir, fullPath).replace(/\\/g, '/');
    if (ignorePrefixes.has(entry.name) || ignorePrefixes.has(rel)) continue;

    if (entry.isDirectory()) {
      await scanIndexableFilesAsync(rootDir, ignorePrefixes, fullPath, acc);
    } else if (entry.isFile() && INDEXABLE_EXTS.has(extname(entry.name).toLowerCase())) {
      try {
        const st = await stat(fullPath);
        if (st.size <= 512 * 1024) {
          acc.push(rel);
        }
      } catch {
        // Ignore transient file
      }
    }
  }
  return acc;
}

function resolveImportTarget(
  fromRel: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = posix.dirname(fromRel);
  const base = posix.normalize(posix.join(fromDir, specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}.rs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

export class RepoIndexer {
  private watchers = new Map<string, FSWatcher>();
  private dirtyPaths = new Map<string, Set<string>>();
  private structureVersions = new Map<string, number>();

  constructor(
    private readonly treeSitter: TreeSitterService,
    private readonly store?: SmolCodeStore,
  ) {}

  getStructureVersion(workdir: string): number {
    return this.structureVersions.get(resolve(workdir)) ?? 0;
  }

  markDirty(workdir: string, relPath: string, structural = false): void {
    const root = resolve(workdir);
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    let set = this.dirtyPaths.get(root);
    if (!set) {
      set = new Set();
      this.dirtyPaths.set(root, set);
    }
    set.add(norm);
    if (structural) {
      this.structureVersions.set(root, (this.structureVersions.get(root) ?? 0) + 1);
    }
  }

  startWatching(workdir: string): void {
    const root = resolve(workdir);
    if (this.watchers.has(root) || !existsSync(root)) return;
    try {
      const watcher = watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        const parts = rel.split('/');
        if (parts.some((p) => SKIP_DIRS.has(p))) return;
        const ext = extname(rel).toLowerCase();
        if (ext && !INDEXABLE_EXTS.has(ext)) return;
        this.markDirty(root, rel, eventType === 'rename');
      });
      watcher.on('error', () => {
        this.stopWatching(root);
      });
      this.watchers.set(root, watcher);
    } catch {
      // Recursive fs.watch may be unsupported on some filesystems
    }
  }

  stopWatching(workdir: string): void {
    const root = resolve(workdir);
    const w = this.watchers.get(root);
    if (w) {
      try {
        w.close();
      } catch {
        // Ignore close errors
      }
      this.watchers.delete(root);
    }
  }

  closeAllWatchers(): void {
    for (const root of [...this.watchers.keys()]) {
      this.stopWatching(root);
    }
  }

  async buildIndex(projectId: string, workdir: string): Promise<RepoIndex> {
    const root = resolve(workdir);
    this.startWatching(root);

    const ignorePrefixes = await loadGitIgnorePrefixes(root);
    const relFiles = await scanIndexableFilesAsync(root, ignorePrefixes);
    const cachedRows = this.store ? this.store.getAstCache(projectId) : [];
    const cacheByPath = new Map(cachedRows.map((r) => [r.filePath, r]));
    const dirtySet = this.dirtyPaths.get(root) ?? new Set<string>();
    const files = new Map<string, IndexedFile>();
    const existingSet = new Set(relFiles);

    const CONCURRENCY = 24;
    for (let i = 0; i < relFiles.length; i += CONCURRENCY) {
      const batch = relFiles.slice(i, i + CONCURRENCY);
      const prepared = await Promise.all(
        batch.map(async (relPath) => {
          const absPath = join(root, relPath);
          let st;
          try {
            st = await stat(absPath);
          } catch {
            return null;
          }

          const cached = cacheByPath.get(relPath);
          const isDirty = dirtySet.has(relPath);

          if (
            !isDirty &&
            cached &&
            Math.abs(cached.mtimeMs - st.mtimeMs) < 1 &&
            cached.lineCount > 0
          ) {
            return {
              kind: 'hit' as const,
              relPath,
              entry: {
                relPath,
                mtimeMs: cached.mtimeMs,
                symbols: JSON.parse(cached.symbolsJson) as AstSymbol[],
                imports: JSON.parse(cached.importsJson) as string[],
                lineCount: cached.lineCount,
              },
            };
          }

          let content: string;
          try {
            content = await readFile(absPath, 'utf8');
          } catch {
            return null;
          }

          const lineCount = content.split(/\r?\n/).length;
          const contentHash = createHash('sha1').update(content).digest('hex');

          if (!isDirty && cached && cached.contentHash === contentHash) {
            const entry: IndexedFile = {
              relPath,
              mtimeMs: st.mtimeMs,
              symbols: JSON.parse(cached.symbolsJson) as AstSymbol[],
              imports: JSON.parse(cached.importsJson) as string[],
              lineCount,
            };
            if (cached.lineCount !== lineCount || Math.abs(cached.mtimeMs - st.mtimeMs) >= 1) {
              this.store?.upsertAstCache({
                projectId,
                filePath: relPath,
                mtimeMs: st.mtimeMs,
                contentHash,
                symbolsJson: cached.symbolsJson,
                importsJson: cached.importsJson,
                lineCount,
              });
            }
            return { kind: 'hit' as const, relPath, entry };
          }

          return {
            kind: 'parse' as const,
            relPath,
            mtimeMs: st.mtimeMs,
            content,
            contentHash,
            lineCount,
          };
        }),
      );

      for (const item of prepared) {
        if (!item) continue;
        if (item.kind === 'hit') {
          files.set(item.relPath, item.entry);
        } else {
          const parsed = await this.treeSitter.extractSymbolsAndImports(
            item.relPath,
            item.content,
          );
          const entry: IndexedFile = {
            relPath: item.relPath,
            mtimeMs: item.mtimeMs,
            symbols: parsed.symbols,
            imports: parsed.imports,
            lineCount: item.lineCount,
          };
          files.set(item.relPath, entry);
          this.store?.upsertAstCache({
            projectId,
            filePath: item.relPath,
            mtimeMs: item.mtimeMs,
            contentHash: item.contentHash,
            symbolsJson: JSON.stringify(parsed.symbols),
            importsJson: JSON.stringify(parsed.imports),
            lineCount: item.lineCount,
          });
        }
        dirtySet.delete(item.relPath);
      }
    }

    this.store?.deleteAstCacheMissing(projectId, existingSet);

    const adjacency = new Map<string, Set<string>>();
    const reverseAdj = new Map<string, Set<string>>();
    for (const rel of files.keys()) {
      adjacency.set(rel, new Set());
      reverseAdj.set(rel, new Set());
    }

    for (const [rel, info] of files) {
      for (const imp of info.imports) {
        const target = resolveImportTarget(rel, imp, existingSet);
        if (target && target !== rel) {
          adjacency.get(rel)?.add(target);
          reverseAdj.get(target)?.add(rel);
        }
      }
    }

    return { projectId, workdir: root, files, adjacency, reverseAdj };
  }

  searchSuggestions(index: RepoIndex, query: string, limit = 20): SearchSuggestion[] {
    const q = query.trim().toLowerCase();
    const out: SearchSuggestion[] = [];

    for (const [relPath, info] of index.files) {
      if (!q || relPath.toLowerCase().includes(q)) {
        out.push({
          kind: 'file',
          label: relPath,
          filePath: relPath,
        });
      }
      for (const sym of info.symbols) {
        if (
          !q ||
          sym.name.toLowerCase().includes(q) ||
          `${relPath}:${sym.name}`.toLowerCase().includes(q)
        ) {
          out.push({
            kind: 'symbol',
            label: `${sym.name} — ${relPath}:${sym.startLine}`,
            filePath: relPath,
            symbolName: sym.name,
            startLine: sym.startLine,
            endLine: sym.endLine,
          });
        }
      }
    }

    return out
      .sort((a, b) => {
        const aExact = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bExact = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
        return a.label.localeCompare(b.label);
      })
      .slice(0, limit);
  }

  findSymbolBodyRange(
    index: RepoIndex,
    filePath: string,
    symbolName: string,
  ): { startLine: number; endLine: number } | null {
    const norm = filePath.replace(/\\/g, '/');
    const file = index.files.get(norm);
    if (!file) return null;
    const match =
      file.symbols.find((s) => s.name === symbolName) ??
      file.symbols.find((s) => s.name.endsWith(`.${symbolName}`)) ??
      file.symbols.find((s) => s.name.toLowerCase().includes(symbolName.toLowerCase()));
    if (!match) return null;
    return { startLine: match.startLine, endLine: match.endLine };
  }
}

export function extractMentionedPathsFromText(
  text: string,
  index: RepoIndex,
): string[] {
  const hits = new Set<string>();
  const tokens = text.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g) ?? [];
  for (const raw of tokens) {
    const norm = raw
      .replace(/[.,;:!?)'"`]+$/, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (index.files.has(norm)) {
      hits.add(norm);
      continue;
    }
    for (const rel of index.files.keys()) {
      if (rel.endsWith(`/${norm}`) || (dirname(rel) === '.' && rel === norm)) {
        hits.add(rel);
      }
    }
  }
  return [...hits];
}
