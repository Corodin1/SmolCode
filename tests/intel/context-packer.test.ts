import { describe, expect, it } from 'vitest';
import {
  buildImmutableZoneAPrefix,
  buildNonToolFallbackGuide,
  buildStructuredTurnMemory,
  packThreeZoneContext,
  type StepHistoryItem,
} from '../../electron/intel/context-packer';
import { digestCommandOutput } from '../../electron/intel/error-digest';
import { AGENT_TOOLS } from '../../electron/tools/tool-registry';
import type { TurnRecord } from '../../src/shared/types';

describe('KV-cache context packer & error digest', () => {
  it('keeps Zone A prefix byte-identical across multi-step reasoning', () => {
    const zoneA = buildImmutableZoneAPrefix({
      agentsPrompt: 'Always run vitest.',
      repoSkeleton: 'src/index.ts [20L]\n  function main [L1-10]',
      toolDefs: AGENT_TOOLS,
    });

    const steps: StepHistoryItem[] = Array.from({ length: 5 }, (_, idx) => ({
      id: `s${idx}`,
      assistantContent: `Step ${idx}`,
      toolCalls: [
        {
          name: 'read_range',
          arguments: { filePath: `src/f${idx}.ts`, startLine: 1, endLine: 40 },
          result: 'x\n'.repeat(300),
          isReadOnlySlice: true,
        },
      ],
    }));

    const packed1 = packThreeZoneContext({
      immutableSystemPrompt: zoneA.systemPrompt,
      prefixHash: zoneA.prefixHash,
      prefixTokens: zoneA.prefixTokens,
      userPrompt: 'Fix bug',
      prefetchedContext: '',
      effortGuidance: 'Think concisely.',
      ledger: {
        goal: 'Fix bug',
        inspectedSymbols: ['src/f0.ts'],
        modifiedFiles: [],
        activeErrors: [],
        verifiedChecks: [],
      },
      steps: steps.slice(0, 2),
      numCtx: 16384,
    });

    const packed2 = packThreeZoneContext({
      immutableSystemPrompt: zoneA.systemPrompt,
      prefixHash: zoneA.prefixHash,
      prefixTokens: zoneA.prefixTokens,
      userPrompt: 'Fix bug',
      prefetchedContext: '',
      effortGuidance: 'Think concisely.',
      ledger: {
        goal: 'Fix bug',
        inspectedSymbols: ['src/f0.ts', 'src/f4.ts'],
        modifiedFiles: ['src/f4.ts'],
        activeErrors: [],
        verifiedChecks: [],
      },
      steps,
      numCtx: 16384,
    });

    // Zone A system + user seed messages remain byte-identical for Ollama KV cache reuse
    expect(packed1.messages[0].content).toBe(packed2.messages[0].content);
    expect(packed1.messages[1].content).toBe(packed2.messages[1].content);
    expect(packed1.kvPrefixHash).toBe(packed2.kvPrefixHash);
    // Older read_range tool outputs (>3 steps ago) are folded
    expect(packed2.tokensSavedByFolding).toBeGreaterThan(200);
    const foldedTool = packed2.messages.find(
      (m) => m.role === 'tool' && m.content.includes('[Folded read_range'),
    );
    expect(foldedTool).toBeDefined();
  });

  it('compresses noisy build logs while retaining errors', () => {
    const noisy = [
      ...Array.from({ length: 120 }, (_, i) => `PASS tests/ok_${i}.test.ts`),
      'src/app.ts(14,5): error TS2322: Type "string" is not assignable to type "number".',
      '    at Object.<anonymous> (node_modules/vitest/runner.js:12:3)',
      ...Array.from({ length: 80 }, (_, i) => `info bundle chunk ${i}`),
    ].join('\n');

    const digested = digestCommandOutput(noisy, 1, 1400);
    expect(digested.text).toContain('TS2322');
    expect(digested.text).not.toContain('node_modules/vitest/runner.js');
    expect(digested.savedTokensApprox).toBeGreaterThan(400);
  });

  it('builds structured multi-turn memory and non-tool fallback guide', () => {
    const turns: TurnRecord[] = [
      {
        id: 't1',
        threadId: 'th1',
        role: 'user',
        content: 'Refactor auth middleware and add tests',
        createdAt: 1,
      },
      {
        id: 't2',
        threadId: 'th1',
        role: 'assistant',
        content: 'Updated auth.ts and added unit tests covering expired JWTs.',
        ledger: {
          goal: 'Refactor auth middleware',
          inspectedSymbols: ['src/auth.ts::verifyToken'],
          modifiedFiles: ['src/auth.ts', 'tests/auth.test.ts'],
          activeErrors: [],
          verifiedChecks: ['vitest passed'],
        },
        createdAt: 2,
      },
    ];

    const memory = buildStructuredTurnMemory(turns, 800);
    expect(memory).toContain('Modified files: src/auth.ts, tests/auth.test.ts');
    expect(memory).toContain('Verified checks: vitest passed');

    const guide = buildNonToolFallbackGuide(AGENT_TOOLS);
    expect(guide).toContain('<tool_call>');
    expect(guide).toContain('patch_hashline');

    const zoneA = buildImmutableZoneAPrefix({
      agentsPrompt: 'Always run vitest.',
      repoSkeleton: '',
      toolDefs: AGENT_TOOLS,
      nonToolFallbackGuide: guide,
      skillCatalog: '- smolcode-testing [repo]: Run Vitest tests cleanly',
    });
    expect(zoneA.systemPrompt).toContain('Prefer patch_hashline');
    expect(zoneA.systemPrompt).toContain('<tool_call>');
    expect(zoneA.systemPrompt).toContain('Available Skills');
    expect(zoneA.systemPrompt).toContain('smolcode-testing [repo]');
    expect(zoneA.systemPrompt).toContain('save_skill');
  });
});
