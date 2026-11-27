import { describe, expect, it } from 'vitest';
import { LoopGuard } from '../../electron/agent/loop-guard';

describe('LoopGuard mutation-aware invalidation', () => {
  it('invalidates read and command fingerprints after workspace mutations', () => {
    const guard = new LoopGuard();
    expect(guard.getMutationEpoch()).toBe(0);

    // First read & command allowed
    expect(guard.recordToolAttempt('read_range', { filePath: 'src/a.ts', startLine: 1, endLine: 40 }).action).toBe('allow');
    expect(guard.recordToolAttempt('run_command', { command: 'npm test' }).action).toBe('allow');

    // Immediate identical read retry returns non-error dedup; command retry still triggers pivot
    const readDedup = guard.recordToolAttempt('read_range', { filePath: 'src/a.ts', startLine: 1, endLine: 40 });
    expect(readDedup.action).toBe('dedup');
    expect(readDedup.reason).toContain('unchanged workspace state');

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

  it('recovers from 8-edit churn on read refresh, ignores rejected edits, and unlocks folded reads', () => {
    const guard = new LoopGuard();

    // 8 applied edits on main.py (with mixed ./ prefix normalization)
    for (let i = 0; i < 8; i++) {
      const path = i % 2 === 0 ? 'main.py' : './main.py';
      expect(
        guard.recordToolAttempt('patch_hashline', { filePath: path, edits: [{ n: i }] }).action,
      ).toBe('allow');
      guard.recordAppliedEdit(path);
    }

    // 9th attempt triggers pivot without inflating churn count; rejected attempts don't deadlock
    const churnPivot = guard.recordToolAttempt('patch_hashline', {
      filePath: 'main.py',
      edits: [{ n: 8 }],
    });
    expect(churnPivot.action).toBe('pivot');
    expect(churnPivot.reason).toContain('8 times');

    // Re-reading via read_range resets churn so editing resumes cleanly
    expect(
      guard.recordToolAttempt('read_range', { filePath: 'main.py', startLine: 105, endLine: 145 })
        .action,
    ).toBe('allow');
    guard.recordReadRefresh('main.py');

    expect(
      guard.recordToolAttempt('patch_hashline', { filePath: 'main.py', edits: [{ n: 9 }] }).action,
    ).toBe('allow');

    // Context-packer folded read invalidation unlocks one re-read, then dedups at 2x/3x and halts at 4x
    guard.invalidateFoldedReads([
      {
        stepId: 'step-1',
        name: 'read_range',
        arguments: { filePath: 'main.py', startLine: 105, endLine: 145 },
      },
    ]);
    expect(
      guard.recordToolAttempt('read_range', { filePath: 'main.py', startLine: 105, endLine: 145 })
        .action,
    ).toBe('allow');
    expect(
      guard.recordToolAttempt('read_range', { filePath: 'main.py', startLine: 105, endLine: 145 })
        .action,
    ).toBe('dedup');
    expect(
      guard.recordToolAttempt('read_range', { filePath: 'main.py', startLine: 105, endLine: 145 })
        .action,
    ).toBe('dedup');
    expect(
      guard.recordToolAttempt('read_range', { filePath: 'main.py', startLine: 105, endLine: 145 })
        .action,
    ).toBe('halt');

    // In-context read dedup halts at 6x across sub-ranges on the same file, and resets on mutation
    for (let i = 0; i < 5; i++) {
      expect(
        guard.recordInContextReadHit('read_range', 'cube_demo.py', 'Already in context').action,
      ).toBe('dedup');
    }
    expect(
      guard.recordInContextReadHit('read_range', 'cube_demo.py', 'Already in context').action,
    ).toBe('halt');
    guard.invalidateOnMutation('cube_demo.py');
    expect(
      guard.recordInContextReadHit('read_range', 'cube_demo.py', 'Already in context').action,
    ).toBe('dedup');

    // Repeated verify_gate failures halt at 3x and clear on mutation
    expect(guard.recordOutcome('verify_gate:typecheck', true, 'TS2322').action).toBe('allow');
    expect(guard.recordOutcome('verify_gate:typecheck', true, 'TS2322').action).toBe('allow');
    expect(guard.recordOutcome('verify_gate:typecheck', true, 'TS2322').action).toBe('halt');
    guard.invalidateOnMutation('main.py');
    expect(guard.recordOutcome('verify_gate:typecheck', true, 'TS2322').action).toBe('allow');
  });
});
