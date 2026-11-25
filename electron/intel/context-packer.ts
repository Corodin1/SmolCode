import { createHash } from 'node:crypto';
import type { TurnRecord, WorkingMemoryLedger } from '../../src/shared/types';
import type { OllamaChatMessage, OllamaToolDef } from '../ollama/client';
import { digestCommandOutput } from './error-digest';

export interface StepHistoryItem {
  id: string;
  assistantContent: string;
  assistantThinking?: string;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result: string;
    isReadOnlySlice?: boolean;
    isCommandOutput?: boolean;
    exitCode?: number;
  }>;
}

export interface PackedContextResult {
  messages: OllamaChatMessage[];
  kvPrefixHash: string;
  kvPrefixTokens: number;
  activeContextTokens: number;
  tokensSavedByFolding: number;
  foldedReadCalls: Array<{ stepId: string; name: string; arguments: Record<string, unknown> }>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildNonToolFallbackGuide(toolDefs: OllamaToolDef[]): string {
  const toolLines = toolDefs.map((t) => {
    const props = (t.function.parameters as { properties?: Record<string, unknown> })?.properties ?? {};
    const keys = Object.keys(props).join(', ');
    return `- ${t.function.name}(${keys}): ${t.function.description}`;
  });
  return [
    `## Tool Calling Format (Text Mode)`,
    `This model does not use native tool schemas. To invoke a tool, emit one or more XML tags containing valid JSON:`,
    `<tool_call>{"name": "tool_name", "arguments": {"arg": "value"}}</tool_call>`,
    `Available tools:`,
    ...toolLines,
  ].join('\n');
}

/**
 * Zone A is constructed at turn start and kept invariant within the turn so Ollama's
 * KV cache hits byte-for-byte on steps 2..N. Refreshed incrementally across turns
 * only when repository structure, mode, or toolset changes.
 */
export function buildImmutableZoneAPrefix(params: {
  agentsPrompt: string;
  repoSkeleton: string;
  toolDefs: OllamaToolDef[];
  interactionMode?: 'build' | 'plan';
  nonToolFallbackGuide?: string;
  skillCatalog?: string;
}): { systemPrompt: string; prefixHash: string; prefixTokens: number } {
  const isPlan = params.interactionMode === 'plan';
  const osShellRule =
    process.platform === 'win32'
      ? `- Host OS: Windows (run_command uses cmd.exe, NOT bash — never run sleep, cat, head, tail, grep, ls, or rm; use read_range/repo_search/delete_file tools, or Windows/Python commands like timeout /t, type, findstr, dir, python).`
      : `- Host OS: ${process.platform} (run_command runs a POSIX shell).`;
  const parts = [
    `You are SmolCode, an autonomous local coding agent.`,
    `Rules:`,
    osShellRule,
    `- Act directly on Prefetched Context Slices without redundant re-reads.`,
    `- Use read_symbol / read_range before editing; use list_dir / find_files for layout or non-code files.`,
    `- If Available Skills lists a matching skill, call read_skill(name) first.`,
    isPlan
      ? `- PLAN MODE (read-only): Explore without modifying files, clarify ambiguity with request_user_input, and call propose_plan before finish_turn.`
      : `- Prefer <file_write path="...">...</file_write>, <replace_symbol path="..." symbol="...">...</replace_symbol>, or <replace_range path="..." start="..." end="...">...</replace_range> with complete raw code (no "... existing code ..." placeholders) for new files or multi-line edits. Prefer patch_hashline (exact line:hash anchors) for small 1-3 line fixes; reserve patch_file for short unique blocks. Syntax is auto-checked.`,
    !isPlan
      ? `- When following an approved plan, update steps via update_plan_step.`
      : '',
    `- Verify changes when appropriate, then call finish_turn.`,
  ].filter(Boolean);

  if (params.agentsPrompt.trim()) {
    parts.push(`\n## Project Instructions (AGENTS.md)\n${params.agentsPrompt.trim()}`);
  }

  if (params.skillCatalog?.trim()) {
    parts.push(
      `\n## Available Skills (call read_skill to load full instructions)\n${params.skillCatalog.trim()}`,
    );
  }

  if (params.repoSkeleton.trim()) {
    parts.push(`\n## Structural Repo Skeleton (PageRank-ordered)\n${params.repoSkeleton.trim()}`);
  }

  if (params.nonToolFallbackGuide?.trim()) {
    parts.push(`\n${params.nonToolFallbackGuide.trim()}`);
  }

  const systemPrompt = parts.join('\n');
  const hashInput = JSON.stringify({ systemPrompt, tools: params.toolDefs });
  const prefixHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

  return {
    systemPrompt,
    prefixHash,
    prefixTokens: estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(params.toolDefs)),
  };
}

export function buildStructuredTurnMemory(
  priorTurns: TurnRecord[],
  tokenBudget = 1200,
): string {
  if (priorTurns.length === 0) return '';

  const blocks: string[] = [];
  let usedTokens = 0;

  // Walk newest-to-oldest so recent turns and ledgers fit cleanly inside tokenBudget
  for (let i = priorTurns.length - 1; i >= 0; i--) {
    const turn = priorTurns[i];
    const parts: string[] = [];

    if (turn.role === 'user') {
      const cleaned = turn.content.trim().replace(/\s+/g, ' ');
      if (cleaned) {
        parts.push(`User: ${cleaned.slice(0, 600)}`);
      }
    } else {
      if (turn.ledger) {
        const l = turn.ledger;
        const ledgerLines = [`Assistant Turn Summary:`];
        if (l.goal) ledgerLines.push(`  Goal: ${l.goal}`);
        if (l.modifiedFiles.length > 0) {
          ledgerLines.push(`  Modified files: ${l.modifiedFiles.join(', ')}`);
        }
        if (l.verifiedChecks.length > 0) {
          ledgerLines.push(`  Verified checks: ${l.verifiedChecks.join('; ')}`);
        }
        if (l.activeErrors.length > 0) {
          ledgerLines.push(`  Unresolved errors: ${l.activeErrors.slice(-2).join(' | ').slice(0, 240)}`);
        }
        parts.push(ledgerLines.join('\n'));
      }
      if (turn.plan) {
        const doneCount = turn.plan.steps.filter((s) => s.status === 'done').length;
        parts.push(
          `  Plan "${turn.plan.title}" (${turn.plan.approved ? 'approved' : 'proposed'}, ${doneCount}/${turn.plan.steps.length} done)`,
        );
      }
      const cleaned = turn.content.trim();
      if (cleaned) {
        const maxReplyChars = turn.ledger ? 420 : 650;
        parts.push(
          `  Outcome: ${cleaned.length > maxReplyChars ? `${cleaned.slice(0, maxReplyChars)}...` : cleaned}`,
        );
      }
    }

    const block = parts.join('\n').trim();
    if (!block) continue;
    const cost = estimateTokens(block);
    if (usedTokens + cost > tokenBudget && blocks.length > 0) {
      break;
    }
    blocks.unshift(block);
    usedTokens += cost;
  }

  return blocks.join('\n\n');
}

export function formatLedgerBlock(ledger: WorkingMemoryLedger): string {
  const lines = [
    `## Working Memory Ledger`,
    `Goal: ${ledger.goal}`,
    `Inspected: ${ledger.inspectedSymbols.slice(-12).join(', ') || 'none'}`,
    `Modified: ${ledger.modifiedFiles.join(', ') || 'none'}`,
    `Verified: ${ledger.verifiedChecks.slice(-6).join('; ') || 'none'}`,
  ];
  if (ledger.activeErrors.length > 0) {
    lines.push(`Active Errors:\n${ledger.activeErrors.slice(-4).join('\n')}`);
  }
  return lines.join('\n');
}

export function packThreeZoneContext(params: {
  immutableSystemPrompt: string;
  prefixHash: string;
  prefixTokens: number;
  userPrompt: string;
  prefetchedContext: string;
  images?: string[];
  effortGuidance: string;
  ledger: WorkingMemoryLedger;
  steps: StepHistoryItem[];
  numCtx: number;
  steeringNotes?: string[];
}): PackedContextResult {
  const baseMessages: OllamaChatMessage[] = [
    // ZONE A: Immutable KV-cache-locked system prefix
    {
      role: 'system',
      content: params.immutableSystemPrompt,
    },
    // Turn seed (kept strictly invariant within the turn; steering appends at tail)
    {
      role: 'user',
      content: [
        params.userPrompt,
        params.prefetchedContext
          ? `\n## Prefetched Context Slices\n${params.prefetchedContext}`
          : '',
        `\n## Effort Policy\n${params.effortGuidance}`,
      ]
        .filter(Boolean)
        .join('\n'),
      ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
    },
  ];

  // Estimate raw append-only token footprint first so we NEVER break Ollama's
  // prefix KV cache prematurely while under the soft VRAM watermark.
  const softBudget = Math.floor(params.numCtx * 0.70);
  const hardBudget = Math.floor(params.numCtx * 0.82);

  let rawTokens =
    params.prefixTokens +
    estimateTokens(baseMessages[1].content);
  for (const step of params.steps) {
    rawTokens += estimateTokens(step.assistantContent);
    for (const tc of step.toolCalls) {
      rawTokens += estimateTokens(tc.result) + 24;
    }
  }
  for (const note of params.steeringNotes ?? []) {
    rawTokens += estimateTokens(note) + 16;
  }

  // Only fold once context exceeds softBudget; fold in 4-step epochs so subsequent
  // steps remain strictly append-only until the next epoch boundary.
  const needsCompaction = rawTokens > softBudget && params.steps.length >= 4;
  const foldUntilStep = needsCompaction
    ? Math.max(
        0,
        Math.floor(Math.max(0, params.steps.length - 2) / 4) * 4 ||
          Math.max(0, params.steps.length - 3),
      )
    : 0;

  let tokensSavedByFolding = 0;
  const foldedReadCalls: Array<{ stepId: string; name: string; arguments: Record<string, unknown> }> = [];
  const messages: OllamaChatMessage[] = [...baseMessages];

  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i];
    const isFoldedEpoch = i < foldUntilStep;

    messages.push({
      role: 'assistant',
      content: step.assistantContent,
      ...(step.toolCalls.length > 0
        ? {
            tool_calls: step.toolCalls.map((tc) => ({
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    });

    for (const tc of step.toolCalls) {
      let resultContent = tc.result;

      if (isFoldedEpoch && tc.isReadOnlySlice && resultContent.length > 260) {
        const target =
          String(tc.arguments.filePath ?? tc.arguments.path ?? tc.arguments.query ?? 'target');
        const folded = `[Folded ${tc.name}(${target}) — already reflected in Working Memory Ledger; re-read if needed]`;
        tokensSavedByFolding += Math.max(
          0,
          estimateTokens(resultContent) - estimateTokens(folded),
        );
        resultContent = folded;
        foldedReadCalls.push({ stepId: step.id, name: tc.name, arguments: tc.arguments });
      } else if (tc.isCommandOutput && resultContent.length > 2400) {
        const digested = digestCommandOutput(
          resultContent,
          tc.exitCode ?? 0,
          isFoldedEpoch ? 900 : 2200,
        );
        tokensSavedByFolding += digested.savedTokensApprox;
        resultContent = digested.text;
      }

      messages.push({
        role: 'tool',
        tool_name: tc.name,
        content: resultContent,
      });
    }

    // Inject Working Memory Ledger right at the folded epoch boundary (once compacted),
    // keeping everything after `foldUntilStep` strictly append-only.
    if (needsCompaction && foldUntilStep > 0 && i === foldUntilStep - 1) {
      messages.push({
        role: 'user',
        content: `${formatLedgerBlock(params.ledger)}\nContinue toward the goal.`,
      });
    }
  }

  // Append mid-turn steering at the tail so messages[0..N-1] stay KV-cached
  if (params.steeringNotes && params.steeringNotes.length > 0) {
    messages.push({
      role: 'user',
      content: `[User Steering Update]:\n${params.steeringNotes.join('\n')}`,
    });
  }

  // Hard VRAM context budget trim if still above 82% of numCtx
  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  if (totalTokens > hardBudget) {
    for (let i = 2; i < messages.length - 3 && totalTokens > hardBudget; i++) {
      if (messages[i].role === 'tool' && messages[i].content.length > 260) {
        const oldLen = messages[i].content.length;
        messages[i] = {
          ...messages[i],
          content: `${messages[i].content.slice(0, 200)}\n...[trimmed to preserve VRAM KV budget]`,
        };
        const deltaTokens = Math.max(0, Math.round((oldLen - messages[i].content.length) / 4));
        tokensSavedByFolding += deltaTokens;
        totalTokens -= deltaTokens;
      }
    }
  }

  return {
    messages,
    kvPrefixHash: params.prefixHash,
    kvPrefixTokens: params.prefixTokens,
    activeContextTokens: totalTokens,
    tokensSavedByFolding,
    foldedReadCalls,
  };
}
