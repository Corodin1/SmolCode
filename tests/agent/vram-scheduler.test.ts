import { describe, expect, it } from 'vitest';
import { LoopGuard } from '../../electron/agent/loop-guard';
import { OllamaClient } from '../../electron/ollama/client';
import {
  formatEffortSystemDirective,
  getEffortProfile,
} from '../../electron/ollama/effort-profiles';
import { VramScheduler } from '../../electron/ollama/vram-scheduler';
import { DEFAULT_APP_SETTINGS } from '../../electron/store/database';

describe('VRAM Scheduler & Effort Profiles', () => {
  it('serializes concurrent turns by priority (foreground 0 before automation 2)', async () => {
    const scheduler = new VramScheduler(new OllamaClient('http://127.0.0.1:11434'));
    const order: string[] = [];

    let releaseFirst!: () => void;
    const p1 = scheduler.enqueueTurn('t-first', 0, () => {
      order.push('first-start');
      return new Promise<void>((res) => {
        releaseFirst = res;
      });
    });

    const pLow = scheduler.enqueueTurn('t-auto', 2, async () => {
      order.push('automation');
    });

    const pHigh = scheduler.enqueueTurn('t-user', 0, async () => {
      order.push('user-queued');
    });

    await new Promise((r) => setTimeout(r, 15));
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([p1, pLow, pHigh]);
    expect(order).toEqual(['first-start', 'user-queued', 'automation']);
  });

  it('pins distinct Fast model to CPU when cpu-pin-fast is enabled and switches think:false for same model', () => {
    const scheduler = new VramScheduler(new OllamaClient('http://127.0.0.1:11434'));

    const sameFast = scheduler.resolveRoleOptions({
      role: 'fast',
      fastModel: 'qwen3.5:9b',
      mainModel: 'qwen3.5:9b',
      effort: 'high',
      settings: { ...DEFAULT_APP_SETTINGS, pinFastToCpu: true },
    });
    expect(sameFast.think).toBe(false);
    expect(sameFast.options.num_gpu).toBeUndefined();

    const pinnedCpuFast = scheduler.resolveRoleOptions({
      role: 'fast',
      fastModel: 'qwen3:1.7b',
      mainModel: 'qwen3.5:9b',
      effort: 'high',
      settings: { ...DEFAULT_APP_SETTINGS, pinFastToCpu: true },
    });
    expect(pinnedCpuFast.options.num_gpu).toBe(0);

    const low = getEffortProfile('low');
    const med = getEffortProfile('medium');
    const high = getEffortProfile('high');
    const xhigh = getEffortProfile('xhigh');

    // Effort scales thinking, context/output budgets, scout, and verify depth
    expect(low.mainThink).toBe(false);
    expect(med.mainThink).toBe(true);
    expect(high.mainThink).toBe(true);
    expect(xhigh.mainThink).toBe(true);

    expect(low.numCtx).toBe(8192);
    expect(med.numCtx).toBe(12288);
    expect(high.numCtx).toBe(16384);
    expect(xhigh.numCtx).toBe(24576);

    expect(low.numPredict).toBeLessThan(med.numPredict);
    expect(med.numPredict).toBeLessThan(high.numPredict);
    expect(high.numPredict).toBeLessThan(xhigh.numPredict);

    expect(low.runFastScout).toBe(false);
    expect(med.runFastScout).toBe(true);
    expect(high.runFastScout).toBe(true);
    expect(xhigh.runFastScout).toBe(true);

    expect(low.verifyDepth).toBe('syntax');
    expect(med.verifyDepth).toBe('typecheck+tests');
    expect(high.verifyDepth).toBe('typecheck+tests');
    expect(xhigh.verifyDepth).toBe('full-audit');

    expect(formatEffortSystemDirective('low', 'build')).toContain('simple, short, direct code');
    expect(formatEffortSystemDirective('xhigh', 'build')).toContain('ULTRA');
    expect(formatEffortSystemDirective('low', 'plan')).toContain('3-5 concise steps');
    expect(formatEffortSystemDirective('xhigh', 'plan')).toContain('Architecture-Grade Plan');

    // Small <=4B models auto-disable thinking at medium effort to avoid <think> exhaustion
    const tinyOpts = scheduler.resolveRoleOptions({
      role: 'main',
      fastModel: 'qwen3:4b',
      mainModel: 'qwen3:4b',
      effort: 'medium',
      settings: DEFAULT_APP_SETTINGS,
    });
    expect(tinyOpts.think).toBe(false);
    expect(tinyOpts.options.repeat_penalty).toBeGreaterThan(1);
    expect(tinyOpts.options.num_batch).toBe(512);

    // 9B thinking models get thinking-family sampling (presence_penalty + higher temp)
    const smallThinkOpts = scheduler.resolveRoleOptions({
      role: 'main',
      fastModel: 'qwen3.5:9b',
      mainModel: 'qwen3.5:9b',
      effort: 'medium',
      settings: DEFAULT_APP_SETTINGS,
    });
    expect(smallThinkOpts.think).toBe(true);
    expect(smallThinkOpts.options.presence_penalty).toBe(0.4);
    expect(smallThinkOpts.options.temperature).toBeGreaterThanOrEqual(0.25);
  });

  it('distinguishes distinct nested patch_hashline edits in LoopGuard', () => {
    const guard = new LoopGuard();
    const first = guard.recordToolAttempt('patch_hashline', {
      filePath: 'src/a.ts',
      edits: [{ op: 'replace_range', startAnchor: '2:ab', content: 'x' }],
    });
    const secondDifferent = guard.recordToolAttempt('patch_hashline', {
      filePath: 'src/a.ts',
      edits: [{ op: 'replace_range', startAnchor: '2:ab', content: 'y' }],
    });
    const duplicate = guard.recordToolAttempt('patch_hashline', {
      filePath: 'src/a.ts',
      edits: [{ op: 'replace_range', startAnchor: '2:ab', content: 'y' }],
    });
    expect(first.action).toBe('allow');
    expect(secondDifferent.action).toBe('allow');
    expect(duplicate.action).toBe('pivot');
  });
});
