import { createHash } from 'node:crypto';

export interface LoopGuardResult {
  action: 'allow' | 'dedup' | 'pivot' | 'halt';
  reason?: string;
}

const READ_ONLY_LOOP_TOOLS = new Set([
  'repo_search',
  'read_symbol',
  'read_range',
  'list_dir',
  'find_files',
  'web_lookup',
  'read_skill',
]);

const MUTATING_LOOP_TOOLS = new Set([
  'patch_file',
  'patch_hashline',
  'create_file',
  'delete_file',
  'move_file',
  'save_skill',
  '__code_paste_write',
  '__code_paste_symbol',
  '__code_paste_range',
]);

const EDIT_CHURN_TOOLS = new Set([
  'patch_file',
  'patch_hashline',
  '__code_paste_write',
  '__code_paste_symbol',
  '__code_paste_range',
]);

export function normalizeGuardPath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
    .join(',')}}`;
}

export class LoopGuard {
  private callCounts = new Map<string, number>();
  private errorStreaks = new Map<string, number>();
  private fileEditChurn = new Map<string, number>();
  private churnBlocksWithoutRead = new Map<string, number>();
  private invalidatedFoldKeys = new Set<string>();
  private readDedupCounts = new Map<string, number>();
  private mutationEpoch = 0;

  getMutationEpoch(): number {
    return this.mutationEpoch;
  }

  /**
   * Call whenever any workspace file is created, patched, moved, or deleted.
   * Invalidates epoch-scoped read/command fingerprints so post-edit re-reads
   * and re-running verification commands are never falsely blocked.
   */
  invalidateOnMutation(modifiedPath?: string): void {
    this.mutationEpoch += 1;
    const normModified = modifiedPath ? normalizeGuardPath(modifiedPath) : undefined;
    // Clear command error streaks so re-running tests/lint after an edit starts fresh
    for (const key of [...this.errorStreaks.keys()]) {
      if (
        key.startsWith('run_command:') ||
        key.startsWith('verify_gate:') ||
        (normModified && normalizeGuardPath(key).includes(normModified))
      ) {
        this.errorStreaks.delete(key);
      }
    }
  }

  /**
   * Record a successfully applied edit for per-file churn tracking.
   * Rejected/failed edits must NOT inflate edit churn.
   */
  recordAppliedEdit(filePath: string): void {
    const norm = normalizeGuardPath(filePath);
    if (!norm) return;
    this.fileEditChurn.set(norm, (this.fileEditChurn.get(norm) ?? 0) + 1);
    this.churnBlocksWithoutRead.delete(norm);
  }

  /**
   * Reset per-file edit churn once the agent refreshes its view of the file
   * via read_symbol or read_range.
   */
  recordReadRefresh(filePath: string): void {
    const norm = normalizeGuardPath(filePath);
    if (!norm) return;
    this.fileEditChurn.delete(norm);
    this.churnBlocksWithoutRead.delete(norm);
  }

  /**
   * Allow re-reading slices whose earlier output was folded out of prompt context
   * by context-packer, invalidating each folded entry at most once.
   */
  invalidateFoldedReads(
    foldedCalls: Array<{ stepId?: string; name: string; arguments: Record<string, unknown> }>,
  ): void {
    for (let i = 0; i < foldedCalls.length; i++) {
      const item = foldedCalls[i];
      const fp = this.fingerprint(item.name, item.arguments);
      const onceKey = `${item.stepId ?? 'fold'}:${item.name}:${fp}`;
      if (this.invalidatedFoldKeys.has(onceKey)) continue;
      this.invalidatedFoldKeys.add(onceKey);
      this.callCounts.delete(fp);
    }
  }

  private fingerprint(toolName: string, args: Record<string, unknown>): string {
    const normalizedArgs =
      typeof args.filePath === 'string'
        ? { ...args, filePath: normalizeGuardPath(args.filePath) }
        : args;
    const stable = canonicalStringify(normalizedArgs);
    const epochScoped =
      READ_ONLY_LOOP_TOOLS.has(toolName) || toolName === 'run_command'
        ? `e${this.mutationEpoch}:`
        : '';
    return createHash('sha1')
      .update(`${epochScoped}${toolName}:${stable}`)
      .digest('hex')
      .slice(0, 12);
  }

  recordToolAttempt(toolName: string, args: Record<string, unknown>): LoopGuardResult {
    const fp = this.fingerprint(toolName, args);
    const nextCount = (this.callCounts.get(fp) ?? 0) + 1;
    this.callCounts.set(fp, nextCount);

    const isReadOnly = READ_ONLY_LOOP_TOOLS.has(toolName);
    const isMutating = MUTATING_LOOP_TOOLS.has(toolName);

    if (nextCount === 2 || (isReadOnly && nextCount === 3)) {
      if (isReadOnly) {
        return {
          action: 'dedup',
          reason: `LoopGuard: "${toolName}" was already called on this unchanged workspace state. Act on what you already read (e.g. <replace_symbol>/<file_write>/patch_hashline) or inspect a different symbol/line range.`,
        };
      }
      if (toolName === 'run_command') {
        return {
          action: 'pivot',
          reason: `LoopGuard: "${toolName}" was already run with no file edits since the last run. Inspect the error output and edit the code before re-running.`,
        };
      }
      if (isMutating) {
        return {
          action: 'pivot',
          reason: `LoopGuard: identical "${toolName}" call repeated. Re-read the target file with read_range to refresh line:hash anchors or verify file existence before retrying.`,
        };
      }
      return {
        action: 'pivot',
        reason: `LoopGuard: "${toolName}" was just called with identical arguments. Change approach or inspect a different target.`,
      };
    }

    if ((isReadOnly && nextCount >= 4) || (!isReadOnly && nextCount >= 3)) {
      const hint = isReadOnly
        ? 'Repeated identical inspection without progress.'
        : isMutating
          ? 'Repeated identical mutation attempt failed to make progress.'
          : 'Repeated identical tool invocation.';
      return {
        action: 'halt',
        reason: `Stopped repeated identical call to "${toolName}" (${nextCount}x): ${hint}`,
      };
    }

    if (EDIT_CHURN_TOOLS.has(toolName)) {
      const target = normalizeGuardPath(String(args.filePath ?? ''));
      const edits = this.fileEditChurn.get(target) ?? 0;
      if (edits >= 8) {
        const blocks = (this.churnBlocksWithoutRead.get(target) ?? 0) + 1;
        this.churnBlocksWithoutRead.set(target, blocks);
        if (blocks >= 3) {
          return {
            action: 'halt',
            reason: `LoopGuard halted after ${blocks} consecutive edits to ${target} without re-reading. Inspect the file via read_symbol or read_range before continuing.`,
          };
        }
        return {
          action: 'pivot',
          reason: `LoopGuard: ${target} has been patched ${edits} times without a fresh read. Re-read the full symbol via read_symbol or read_range before making another edit.`,
        };
      }
    }

    return { action: 'allow' };
  }

  /**
   * Tracks redundant in-context read hits on the same file within the current mutationEpoch
   * (e.g., nibbling sub-ranges of a file already loaded in context) and halts only if stuck.
   */
  recordInContextReadHit(toolName: string, filePath: string, pointer: string): LoopGuardResult {
    const norm = normalizeGuardPath(filePath);
    const key = `e${this.mutationEpoch}:${norm}`;
    const count = (this.readDedupCounts.get(key) ?? 0) + 1;
    this.readDedupCounts.set(key, count);
    if (count >= 6) {
      return {
        action: 'halt',
        reason: `Stopped repeated "${toolName}" on "${norm}" (${count}x redundant reads without editing): ${pointer}`,
      };
    }
    return { action: 'dedup', reason: pointer };
  }

  recordOutcome(key: string, isError: boolean, errorText?: string): LoopGuardResult {
    if (!isError) {
      this.errorStreaks.delete(key);
      return { action: 'allow' };
    }
    const errSig = `${key}:${createHash('sha1')
      .update((errorText ?? '').slice(0, 300))
      .digest('hex')
      .slice(0, 8)}`;
    const count = (this.errorStreaks.get(errSig) ?? 0) + 1;
    this.errorStreaks.set(errSig, count);
    if (count >= 3) {
      return {
        action: 'halt',
        reason: `LoopGuard halted turn after 3 identical consecutive errors on ${key}. Recovery: inspect the target file/command output directly and address the root error.`,
      };
    }
    return { action: 'allow' };
  }
}
