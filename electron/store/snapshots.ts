import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { structuredPatch } from 'diff';
import type { SmolCodeStore } from './database';

export interface SnapshotDiffLine {
  type: 'context' | 'add' | 'del' | 'hunk';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface SnapshotDiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  hunks: SnapshotDiffLine[];
}

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.smolcode',
  'dist',
  'out',
  'target',
  '.next',
  '.turbo',
  '__pycache__',
  '.venv',
]);

const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function walkWorkspaceFiles(rootDir: string, currentDir = rootDir): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkWorkspaceFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      try {
        const st = statSync(fullPath);
        if (st.size <= MAX_SNAPSHOT_FILE_BYTES) {
          results.push(normalizeRelPath(relative(rootDir, fullPath)));
        }
      } catch {
        // Ignore unreadable transient files
      }
    }
  }
  return results;
}

export class SnapshotManager {
  private readonly blobDir: string;

  constructor(private readonly store: SmolCodeStore, blobRootDir?: string) {
    this.blobDir = blobRootDir ?? join(store.baseDir, 'blobs');
    mkdirSync(this.blobDir, { recursive: true });
  }

  private blobPath(hash: string): string {
    return join(this.blobDir, hash.slice(0, 2), hash);
  }

  private writeBlob(buf: Buffer): string {
    const hash = createHash('sha256').update(buf).digest('hex');
    const target = this.blobPath(hash);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
    }
    return hash;
  }

  private readBlob(hash: string): Buffer | null {
    const target = this.blobPath(hash);
    if (!existsSync(target)) return null;
    return readFileSync(target);
  }

  captureSnapshot(threadId: string, workdir: string): string {
    const files = walkWorkspaceFiles(workdir);
    const manifest: Record<string, string> = {};
    for (const rel of files) {
      try {
        const buf = readFileSync(join(workdir, rel));
        manifest[rel] = this.writeBlob(buf);
      } catch {
        // Skip files locked by external processes
      }
    }
    const id = randomUUID();
    this.store.saveSnapshot({
      id,
      threadId,
      workdir,
      manifestJson: JSON.stringify(manifest),
      createdAt: Date.now(),
    });
    return id;
  }

  restoreSnapshot(snapshotId: string): {
    restoredFiles: string[];
    removedFiles: string[];
  } {
    const row = this.store.getSnapshot(snapshotId);
    if (!row) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
    const manifest = JSON.parse(row.manifestJson) as Record<string, string>;
    const currentFiles = new Set(walkWorkspaceFiles(row.workdir));
    const restoredFiles: string[] = [];
    const removedFiles: string[] = [];

    for (const currentRel of currentFiles) {
      if (!(currentRel in manifest)) {
        rmSync(join(row.workdir, currentRel), { force: true });
        removedFiles.push(currentRel);
      }
    }

    for (const [rel, hash] of Object.entries(manifest)) {
      const target = join(row.workdir, rel);
      const buf = this.readBlob(hash);
      if (!buf) continue;
      let changed = true;
      if (existsSync(target)) {
        const existingHash = createHash('sha256')
          .update(readFileSync(target))
          .digest('hex');
        if (existingHash === hash) {
          changed = false;
        }
      }
      if (changed) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, buf);
        restoredFiles.push(rel);
      }
    }

    return { restoredFiles, removedFiles };
  }

  diffSnapshotToWorkdir(snapshotId: string, workdirOverride?: string): SnapshotDiffFile[] {
    const row = this.store.getSnapshot(snapshotId);
    if (!row) return [];
    const workdir = workdirOverride ?? row.workdir;
    const manifest = JSON.parse(row.manifestJson) as Record<string, string>;
    const currentFiles = walkWorkspaceFiles(workdir);
    const allPaths = new Set([...Object.keys(manifest), ...currentFiles]);
    const diffs: SnapshotDiffFile[] = [];

    for (const rel of [...allPaths].sort()) {
      const prevHash = manifest[rel];
      const abs = join(workdir, rel);
      const currExists = existsSync(abs);

      if (prevHash && currExists) {
        const currBuf = readFileSync(abs);
        const currHash = createHash('sha256').update(currBuf).digest('hex');
        if (currHash === prevHash) continue;
        const prevText = (this.readBlob(prevHash) ?? Buffer.alloc(0)).toString('utf8');
        const currText = currBuf.toString('utf8');
        diffs.push(buildDiffFile(rel, 'modified', prevText, currText));
      } else if (!prevHash && currExists) {
        const currText = readFileSync(abs, 'utf8');
        diffs.push(buildDiffFile(rel, 'added', '', currText));
      } else if (prevHash && !currExists) {
        const prevText = (this.readBlob(prevHash) ?? Buffer.alloc(0)).toString('utf8');
        diffs.push(buildDiffFile(rel, 'deleted', prevText, ''));
      }
    }

    return diffs;
  }
}

export function buildDiffFile(
  filePath: string,
  status: SnapshotDiffFile['status'],
  oldText: string,
  newText: string,
): SnapshotDiffFile {
  const patch = structuredPatch(filePath, filePath, oldText, newText, '', '', {
    context: 3,
  });
  const lines: SnapshotDiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (const hunk of patch.hunks) {
    lines.push({
      type: 'hunk',
      oldLine: hunk.oldStart,
      newLine: hunk.newStart,
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    let oldLn = hunk.oldStart;
    let newLn = hunk.newStart;
    for (const raw of hunk.lines) {
      if (raw.startsWith('+')) {
        additions += 1;
        lines.push({
          type: 'add',
          oldLine: null,
          newLine: newLn++,
          content: raw.slice(1),
        });
      } else if (raw.startsWith('-')) {
        deletions += 1;
        lines.push({
          type: 'del',
          oldLine: oldLn++,
          newLine: null,
          content: raw.slice(1),
        });
      } else if (raw.startsWith(' ')) {
        lines.push({
          type: 'context',
          oldLine: oldLn++,
          newLine: newLn++,
          content: raw.slice(1),
        });
      }
    }
  }

  return {
    path: filePath,
    status,
    additions,
    deletions,
    hunks: lines,
  };
}
