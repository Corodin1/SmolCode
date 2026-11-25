import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { applyFuzzyPatch } from '../intel/fuzzy-patch';
import {
  applyHashlineEdits,
  formatHashlineSlice,
  lineHash,
  type HashlineEdit,
} from '../intel/hashline';
import type { RepoIndex, RepoIndexer } from '../intel/repo-indexer';
import type { TreeSitterService } from '../intel/tree-sitter-service';
import { verifySyntaxGate } from './verify-gate';

const FS_SKIP_DIRS = new Set([
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

function loadIgnoreNames(workdir: string): Set<string> {
  const ignorePath = join(workdir, '.gitignore');
  const out = new Set<string>();
  if (!existsSync(ignorePath)) return out;
  try {
    const raw = readFileSync(ignorePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('!')) continue;
      out.add(cleaned.replace(/^\/+/, '').replace(/\/+$/, ''));
    }
  } catch {
    // Ignore unreadable .gitignore
  }
  return out;
}

function globToRegex(pattern: string): RegExp {
  const norm = pattern.trim().replace(/\\/g, '/');
  if (!norm.includes('*') && !norm.includes('?')) {
    return new RegExp(norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  let expr = '';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          expr += '(?:.*/)?';
          i += 2;
        } else {
          expr += '.*';
          i += 1;
        }
      } else {
        expr += '[^/]*';
      }
    } else if (ch === '?') {
      expr += '[^/]';
    } else {
      expr += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const anchored = norm.includes('/') ? `^${expr}$` : `(?:^|/)${expr}$`;
  return new RegExp(anchored, 'i');
}

function expandHomePrefix(targetPath: string): string {
  if (targetPath === '~') return homedir();
  if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return join(homedir(), targetPath.slice(2));
  }
  return targetPath;
}

export function resolveInsideWorkdir(
  workdir: string,
  targetPath: string,
): { absPath: string; relPath: string; inside: boolean } {
  const absWorkdir = resolve(expandHomePrefix(workdir));
  const expandedTarget = expandHomePrefix(targetPath);
  const absPath = isAbsolute(expandedTarget)
    ? resolve(expandedTarget)
    : resolve(absWorkdir, expandedTarget);
  const rel = relative(absWorkdir, absPath).replace(/\\/g, '/');
  const inside = rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  return { absPath, relPath: rel, inside };
}

export function runListDir(
  workdir: string,
  dirPath = '.',
  maxDepth = 2,
  maxEntries = 200,
): string {
  const { absPath, relPath, inside } = resolveInsideWorkdir(workdir, dirPath || '.');
  if (!inside || !existsSync(absPath)) {
    throw new Error(`Directory not found inside workspace: ${dirPath}`);
  }
  const st = statSync(absPath);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${relPath || '.'}`);
  }

  const boundedDepth = Math.max(1, Math.min(5, Math.floor(maxDepth || 2)));
  const ignores = loadIgnoreNames(workdir);
  const lines: string[] = [`Directory: ${relPath || '.'} (depth ${boundedDepth})`];
  let count = 0;
  let truncated = false;

  const walk = (currentAbs: string, depth: number, indent: string) => {
    if (count >= maxEntries) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(currentAbs, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      if (FS_SKIP_DIRS.has(entry.name)) continue;
      const full = join(currentAbs, entry.name);
      const rel = relative(resolve(workdir), full).replace(/\\/g, '/');
      if (ignores.has(entry.name) || ignores.has(rel)) continue;

      count += 1;
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        if (depth < boundedDepth) {
          walk(full, depth + 1, `${indent}  `);
        }
      } else {
        let sizeHint = '';
        try {
          const fst = statSync(full);
          sizeHint = fst.size < 1024 ? ` (${fst.size}B)` : ` (${Math.round(fst.size / 1024)}KB)`;
        } catch {
          // Ignore transient stat errors
        }
        lines.push(`${indent}${entry.name}${sizeHint}`);
      }
    }
  };

  walk(absPath, 1, '');
  if (truncated) {
    lines.push(`... (truncated at ${maxEntries} entries; pass a deeper dirPath or narrower find_files pattern)`);
  }
  return lines.join('\n');
}

export function runFindFiles(
  workdir: string,
  pattern: string,
  pathPrefix?: string,
  maxResults = 80,
): string {
  const q = pattern.trim();
  if (!q) return 'Empty file pattern.';

  const startSubdir = pathPrefix?.trim() ? pathPrefix.trim() : '.';
  const { absPath: startAbs, inside } = resolveInsideWorkdir(workdir, startSubdir);
  if (!inside || !existsSync(startAbs)) {
    throw new Error(`Search root not found inside workspace: ${startSubdir}`);
  }

  const rx = globToRegex(q);
  const ignores = loadIgnoreNames(workdir);
  const absRoot = resolve(workdir);
  const matches: string[] = [];
  let visited = 0;

  const walk = (currentAbs: string) => {
    if (matches.length >= maxResults || visited >= 6000) return;
    let entries;
    try {
      entries = readdirSync(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults || visited >= 6000) return;
      if (FS_SKIP_DIRS.has(entry.name)) continue;
      const full = join(currentAbs, entry.name);
      const rel = relative(absRoot, full).replace(/\\/g, '/');
      if (ignores.has(entry.name) || ignores.has(rel)) continue;
      visited += 1;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (rx.test(rel) || rx.test(entry.name)) {
          matches.push(rel);
        }
      }
    }
  };

  walk(startAbs);
  return matches.length > 0
    ? matches.join('\n')
    : `No files matched pattern "${pattern}"${pathPrefix ? ` under ${pathPrefix}` : ''}.`;
}

export function runRepoSearch(
  index: RepoIndex,
  query: string,
  pathPrefix?: string,
  maxHits = 30,
  readLines?: (relPath: string) => string[] | null,
): string {
  const q = query.trim();
  if (!q) return 'Empty search query.';

  let regex: RegExp;
  try {
    regex = new RegExp(q, 'i');
  } catch {
    regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const hits: string[] = [];
  const normPrefix = pathPrefix?.replace(/\\/g, '/').replace(/^\/+/, '');

  for (const [relPath, info] of index.files) {
    if (normPrefix && !relPath.startsWith(normPrefix)) continue;

    // Match symbol names directly first
    for (const sym of info.symbols) {
      if (regex.test(sym.name)) {
        hits.push(`${relPath}:${sym.startLine} [symbol ${sym.kind} ${sym.name} L${sym.startLine}-${sym.endLine}]`);
        if (hits.length >= maxHits) return hits.join('\n');
      }
    }

    // Search file contents (preferring cached lines from RepoIndexer)
    try {
      const lines =
        readLines?.(relPath) ??
        readFileSync(join(index.workdir, relPath), 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push(`${relPath}:${i + 1}:${lineHash(lines[i])}| ${lines[i].trim().slice(0, 140)}`);
          if (hits.length >= maxHits) return hits.join('\n');
        }
      }
    } catch {
      // Ignore unreadable file
    }
  }

  return hits.length > 0 ? hits.join('\n') : `No matches found for "${query}".`;
}

export function runReadSymbol(
  index: RepoIndex,
  indexer: RepoIndexer,
  filePath: string,
  symbolName: string,
): { output: string; startLine: number; endLine: number; tokensSavedApprox: number } {
  const { absPath, relPath, inside } = resolveInsideWorkdir(index.workdir, filePath);
  if (!inside || !existsSync(absPath)) {
    throw new Error(`File not found inside workspace: ${filePath}`);
  }
  const text = readFileSync(absPath, 'utf8');
  const totalLines = text.split(/\r?\n/).length;
  const range = indexer.findSymbolBodyRange(index, relPath, symbolName);

  if (!range) {
    const fileInfo = index.files.get(relPath);
    const symList =
      fileInfo?.symbols.map((s) => `${s.name} [L${s.startLine}-${s.endLine}]`).join(', ') ||
      'none';
    const clampedEnd = Math.min(80, totalLines);
    const slice = formatHashlineSlice(text, 1, clampedEnd);
    return {
      output: `Symbol "${symbolName}" not found in ${relPath}. Available symbols: ${symList}\n\n${slice}`,
      startLine: 1,
      endLine: clampedEnd,
      tokensSavedApprox: 0,
    };
  }

  const startLine = Math.max(1, range.startLine - 3);
  const endLine = Math.min(totalLines, range.endLine + 3);
  const slice = formatHashlineSlice(text, startLine, endLine);
  const savedChars = Math.max(0, text.length - slice.length);

  return {
    output: `File: ${relPath} (symbol ${symbolName}, L${startLine}-${endLine}/${totalLines})\n${slice}`,
    startLine,
    endLine,
    tokensSavedApprox: Math.round(savedChars / 4),
  };
}

export function runReadRange(
  workdir: string,
  filePath: string,
  startLine: number,
  endLine: number,
): { output: string; tokensSavedApprox: number } {
  const { absPath, relPath, inside } = resolveInsideWorkdir(workdir, filePath);
  if (!inside || !existsSync(absPath)) {
    throw new Error(`File not found inside workspace: ${filePath}`);
  }
  const text = readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const clampedStart = Math.max(1, startLine);
  const clampedEnd = Math.min(lines.length, Math.max(clampedStart, Math.min(endLine, clampedStart + 179)));
  const slice = formatHashlineSlice(text, clampedStart, clampedEnd);
  const savedChars = Math.max(0, text.length - slice.length);

  return {
    output: `File: ${relPath} (L${clampedStart}-${clampedEnd}/${lines.length})\n${slice}`,
    tokensSavedApprox: Math.round(savedChars / 4),
  };
}

export function normalizeHashlineEdits(rawEdits: unknown[]): HashlineEdit[] {
  return rawEdits.map((raw) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const start =
      item.startAnchor ?? item.start_anchor ?? item.anchor ?? item.start ?? item.line;
    const end = item.endAnchor ?? item.end_anchor ?? item.end;
    const rawOp = String(item.op ?? item.operation ?? 'replace_range');
    const op: HashlineEdit['op'] =
      rawOp === 'insert_after' || rawOp === 'insert_before' || rawOp === 'delete_range'
        ? rawOp
        : 'replace_range';
    return {
      op,
      startAnchor: start !== undefined ? String(start) : '',
      ...(end !== undefined ? { endAnchor: String(end) } : {}),
      ...(item.content !== undefined ? { content: String(item.content) } : {}),
    };
  });
}

export async function runPatchFile(params: {
  workdir: string;
  filePath: string;
  oldText?: string;
  newText?: string;
  edits?: HashlineEdit[];
  treeSitter: TreeSitterService;
  readOnly: boolean;
  allowOutsideRoot?: boolean;
}): Promise<{
  ok: boolean;
  relPath: string;
  absPath: string;
  inside: boolean;
  linesAdded: number;
  linesRemoved: number;
  syntaxOk: boolean;
  output: string;
  tokensSavedByHashline: number;
}> {
  if (params.readOnly) {
    throw new Error('Blocked: thread approval policy is set to read-only.');
  }
  const { absPath, relPath, inside } = resolveInsideWorkdir(params.workdir, params.filePath);
  if (!inside && !params.allowOutsideRoot) {
    throw new Error(`Refusing patch outside active workspace: ${params.filePath}`);
  }
  const displayPath = inside ? relPath : absPath;
  if (!existsSync(absPath)) {
    throw new Error(`Cannot patch missing file: ${relPath}. Use create_file instead.`);
  }

  const original = readFileSync(absPath, 'utf8');
  let applied: {
    nextContent: string;
    linesAdded: number;
    linesRemoved: number;
    minChangedLine: number;
    maxChangedLine: number;
  };

  if (params.edits && params.edits.length > 0) {
    applied = applyHashlineEdits(original, params.edits);
  } else if (params.oldText !== undefined && params.newText !== undefined) {
    applied = applyFuzzyPatch(original, params.oldText, params.newText);
  } else {
    throw new Error('Patch requires either edits[] (patch_hashline) or oldText/newText (patch_file).');
  }

  const syntax = await verifySyntaxGate(params.treeSitter, displayPath, applied.nextContent);
  if (!syntax.ok) {
    return {
      ok: false,
      relPath: displayPath,
      absPath,
      inside,
      linesAdded: 0,
      linesRemoved: 0,
      syntaxOk: false,
      output: `Patch rejected (not written) due to syntax errors:\n${syntax.errorsText}\nFix syntax and retry against the existing file.`,
      tokensSavedByHashline: 0,
    };
  }

  writeFileSync(absPath, applied.nextContent, 'utf8');
  const tokensSavedByHashline = Math.max(12, Math.round((applied.linesRemoved * 28) / 4));

  return {
    ok: true,
    relPath: displayPath,
    absPath,
    inside,
    linesAdded: applied.linesAdded,
    linesRemoved: applied.linesRemoved,
    syntaxOk: true,
    output: `Patched ${displayPath} (+${applied.linesAdded} -${applied.linesRemoved}), syntax OK.`,
    tokensSavedByHashline,
  };
}

export async function runCreateFile(params: {
  workdir: string;
  filePath: string;
  content: string;
  treeSitter: TreeSitterService;
  readOnly: boolean;
  allowOutsideRoot?: boolean;
}): Promise<{
  ok: boolean;
  relPath: string;
  absPath: string;
  inside: boolean;
  linesAdded: number;
  syntaxOk: boolean;
  output: string;
}> {
  if (params.readOnly) {
    throw new Error('Blocked: thread approval policy is set to read-only.');
  }
  const { absPath, relPath, inside } = resolveInsideWorkdir(params.workdir, params.filePath);
  if (!inside && !params.allowOutsideRoot) {
    throw new Error(`Refusing create_file outside active workspace: ${params.filePath}`);
  }
  const displayPath = inside ? relPath : absPath;
  const syntax = await verifySyntaxGate(params.treeSitter, displayPath, params.content);
  if (!syntax.ok) {
    return {
      ok: false,
      relPath: displayPath,
      absPath,
      inside,
      linesAdded: 0,
      syntaxOk: false,
      output: `Create rejected (not written) due to syntax errors:\n${syntax.errorsText}\nFix syntax and retry.`,
    };
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, params.content, 'utf8');

  const linesAdded = params.content.split(/\r?\n/).length;
  return {
    ok: true,
    relPath: displayPath,
    absPath,
    inside,
    linesAdded,
    syntaxOk: true,
    output: `Created ${displayPath} (${linesAdded} lines), syntax check passed.`,
  };
}

export function runDeleteFile(params: {
  workdir: string;
  filePath: string;
  readOnly: boolean;
  allowOutsideRoot?: boolean;
}): { relPath: string; absPath: string; inside: boolean; linesRemoved: number; output: string } {
  if (params.readOnly) {
    throw new Error('Blocked: thread approval policy is set to read-only.');
  }
  const { absPath, relPath, inside } = resolveInsideWorkdir(params.workdir, params.filePath);
  if ((!inside && !params.allowOutsideRoot) || !relPath || relPath === '.' || dirname(absPath) === absPath) {
    throw new Error(`Refusing delete_file outside active workspace: ${params.filePath}`);
  }
  const displayPath = inside ? relPath : absPath;
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${displayPath}`);
  }
  const st = statSync(absPath);
  if (st.isDirectory()) {
    throw new Error(`Refusing to delete directory "${displayPath}" with delete_file.`);
  }
  let linesRemoved = 0;
  try {
    linesRemoved = readFileSync(absPath, 'utf8').split(/\r?\n/).length;
  } catch {
    // Ignore binary/unreadable file size count
  }
  rmSync(absPath);
  return {
    relPath: displayPath,
    absPath,
    inside,
    linesRemoved,
    output: `Deleted ${displayPath} (${linesRemoved} lines removed).`,
  };
}

export function runMoveFile(params: {
  workdir: string;
  fromPath: string;
  toPath: string;
  readOnly: boolean;
  overwrite?: boolean;
  allowOutsideRoot?: boolean;
}): {
  fromRel: string;
  toRel: string;
  fromAbs: string;
  toAbs: string;
  fromInside: boolean;
  toInside: boolean;
  output: string;
} {
  if (params.readOnly) {
    throw new Error('Blocked: thread approval policy is set to read-only.');
  }
  const src = resolveInsideWorkdir(params.workdir, params.fromPath);
  const dst = resolveInsideWorkdir(params.workdir, params.toPath);
  if ((!src.inside && !params.allowOutsideRoot) || !src.relPath || src.relPath === '.') {
    throw new Error(`Refusing move_file source outside workspace: ${params.fromPath}`);
  }
  if ((!dst.inside && !params.allowOutsideRoot) || !dst.relPath || dst.relPath === '.') {
    throw new Error(`Refusing move_file destination outside workspace: ${params.toPath}`);
  }
  const fromDisplay = src.inside ? src.relPath : src.absPath;
  const toDisplay = dst.inside ? dst.relPath : dst.absPath;
  if (!existsSync(src.absPath)) {
    throw new Error(`Source file not found: ${fromDisplay}`);
  }
  if (existsSync(dst.absPath) && !params.overwrite) {
    throw new Error(`Destination already exists: ${toDisplay}`);
  }
  mkdirSync(dirname(dst.absPath), { recursive: true });
  try {
    renameSync(src.absPath, dst.absPath);
  } catch {
    copyFileSync(src.absPath, dst.absPath);
    rmSync(src.absPath);
  }
  return {
    fromRel: fromDisplay,
    toRel: toDisplay,
    fromAbs: src.absPath,
    toAbs: dst.absPath,
    fromInside: src.inside,
    toInside: dst.inside,
    output: `Moved ${fromDisplay} -> ${toDisplay}.`,
  };
}
