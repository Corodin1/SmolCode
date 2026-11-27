import { describe, expect, it } from 'vitest';
import { coalesceRangeBatch, TurnReadCache } from '../../electron/agent/read-cache';

describe('TurnReadCache & range coalescing', () => {
  it('covers sub-ranges from prefetch and tool reads, and serves folded slices from cache', () => {
    const cache = new TurnReadCache();
    cache.recordRange({
      filePath: './cube_demo.py',
      startLine: 1,
      endLine: 108,
      totalLines: 108,
      output: 'File: cube_demo.py (full file L1-108/108)\n1:aa| import pygame',
      source: 'prefetch',
      stepId: 'prefetch',
      stepNumber: 0,
    });

    const inCtx = cache.lookupRange('cube_demo.py', 27, 31);
    expect(inCtx.hit).toBe('in_context');
    if (inCtx.hit === 'in_context') {
      expect(inCtx.pointer).toContain('Prefetched Context Slices');
      expect(inCtx.pointer).toContain('L1-108');
    }

    cache.recordRange({
      filePath: 'big.py',
      startLine: 10,
      endLine: 80,
      totalLines: 400,
      output: 'File: big.py (L10-80/400)\n10:bb| def render(): pass',
      source: 'tool',
      stepId: 'step-1',
      stepNumber: 1,
    });

    expect(cache.lookupRange('big.py', 20, 40).hit).toBe('in_context');

    cache.markFolded([{ stepId: 'step-1' }]);
    const foldedHit = cache.lookupRange('big.py', 20, 40, {
      stepId: 'step-5',
      stepNumber: 5,
    });
    expect(foldedHit.hit).toBe('folded_cached');
    if (foldedHit.hit === 'folded_cached') {
      expect(foldedHit.output).toContain('def render()');
    }

    // After re-serving into step-5, it is active in context again
    expect(cache.lookupRange('big.py', 20, 40).hit).toBe('in_context');

    // Mutating big.py invalidates only big.py
    cache.invalidate('big.py');
    expect(cache.lookupRange('big.py', 20, 40).hit).toBe('miss');
    expect(cache.lookupRange('cube_demo.py', 27, 31).hit).toBe('in_context');
  });

  it('coalesces overlapping or adjacent same-file read_range calls in a batch', () => {
    const plan = coalesceRangeBatch([
      { name: 'read_range', arguments: { filePath: 'a.py', startLine: 20, endLine: 30 } },
      { name: 'read_range', arguments: { filePath: './a.py', startLine: 27, endLine: 45 } },
      { name: 'read_range', arguments: { filePath: 'b.py', startLine: 1, endLine: 20 } },
      { name: 'read_range', arguments: { filePath: 'a.py', startLine: 46, endLine: 60 } },
    ]);

    expect(plan.mergedRanges.get(0)).toEqual({ startLine: 20, endLine: 60 });
    expect(plan.mergedInto.get(1)).toBe(0);
    expect(plan.mergedInto.get(3)).toBe(0);
    expect(plan.mergedInto.has(2)).toBe(false);
  });
});
