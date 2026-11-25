import { describe, expect, it } from 'vitest';
import { LoopGuard } from '../../electron/agent/loop-guard';

describe('LoopGuard mutation-aware invalidation', () => {
  it('invalidates read and command fingerprints after workspace mutations', () => {
    const guard = new LoopGuard();
    expect(guard.getMutationEpoch()).toBe(0);

    // First read & command allowed
    expect(guard.recordToolAttempt('read_range', { filePath: 'src/a.ts', startLine: 1, endLine: 40 }).action).toBe('allow');
    expect(guard.recordToolAttempt('run_command', { command: 'npm test' }).action).toBe('allow');

    // Immediate identical retry without edits triggers pivot with actionable hint
    const readPivot = guard.recordToolAttempt('read_range', { filePath: 'src/a.ts', startLine: 1, endLine: 40 });
    expect(readPivot.action).toBe('pivot');
    expect(readPivot.reason).toContain('unchanged workspace state');

    const cmdPivot = guard.recordToolAttempt('run_command', { command: 'npm test' });
    expect(cmdPivot.action).toBe('pivot');
    expect(cmdPivot.reason).toContain('no file edits');

    // Mutate a file -> epoch increments -> re-reading & re-testing are allowed cleanly
    guard.invalidateOnMutation('src/a.ts');
    expect(guard.getMutationEpoch()).toBe(1);

    expect(guard.recordToolAttempt('read_range', { filePath: 'src/a.ts', startLine: 1, endLine: 40 }).action).toBe('allow');
    expect(guard.recordToolAttempt('run_command', { command: 'npm test' }).action).toBe('allow');
  });

  it('halts stuck mutating loops and clears command error streaks on mutation', () => {
    const guard = new LoopGuard();

    expect(guard.recordToolAttempt('patch_hashline', { filePath: 'src/a.ts', edits: [] }).action).toBe('allow');
    const pivot = guard.recordToolAttempt('patch_hashline', { filePath: 'src/a.ts', edits: [] });
    expect(pivot.action).toBe('pivot');
    expect(pivot.reason).toContain('read_range');

    const halt = guard.recordToolAttempt('patch_hashline', { filePath: 'src/a.ts', edits: [] });
    expect(halt.action).toBe('halt');

    // Command error streak resets once an edit occurs
    expect(guard.recordOutcome('run_command:', true, 'TS2322 error').action).toBe('allow');
    expect(guard.recordOutcome('run_command:', true, 'TS2322 error').action).toBe('allow');
    guard.invalidateOnMutation('src/a.ts');
    expect(guard.recordOutcome('run_command:', true, 'TS2322 error').action).toBe('allow');
  });
});
