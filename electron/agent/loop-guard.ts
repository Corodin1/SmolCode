import { createHash } from 'node:crypto';

export interface LoopGuardResult {
  action: 'allow' | 'pivot' | 'halt';
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
]);

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
    // Clear command error streaks so re-running tests/lint after an edit starts fresh
    for (const key of [...this.errorStreaks.keys()]) {
      if (
        key.startsWith('run_command:') ||
        key.startsWith('verify_gate:') ||
        (modifiedPath && key.includes(modifiedPath))
      ) {
        this.errorStreaks.delete(key);
      }
    }
  }

  private fingerprint(toolName: string, args: Record<string, unknown>): string {
    const stable = canonicalStringify(args);
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

    if (nextCount === 2) {
      if (isReadOnly) {
        return {
          action: 'pivot',
          reason: `LoopGuard: "${toolName}" was already called on this unchanged workspace state. Act on what you already read (e.g. patch_hashline/patch_file) or inspect a different symbol/line range.`,
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

    if (nextCount >= 3) {
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

    if (toolName === 'patch_file' || toolName === 'patch_hashline') {
      const target = String(args.filePath ?? '');
      const edits = (this.fileEditChurn.get(target) ?? 0) + 1;
      this.fileEditChurn.set(target, edits);
      if (edits >= 8) {
        return {
          action: 'pivot',
          reason: `LoopGuard: ${target} has been patched ${edits} times in one turn. Re-read the full symbol via read_symbol or read_range before making another edit.`,
        };
      }
    }

    return { action: 'allow' };
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
