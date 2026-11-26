import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AgentStreamEvent,
  ApprovalDecision,
  ApprovalRequest,
  ComposerChip,
  McpServerConfig,
  OllamaModelInfo,
  QuestionItem,
  QuestionOption,
  StructuredPlan,
  TelemetrySnapshot,
  ThreadRecord,
  ThreadStatus,
  ToolCallLog,
  TurnRecord,
  UserQuestionPrompt,
  WorkingMemoryLedger,
} from '../../src/shared/types';
import { buildAstRepoSkeleton, retrieveRelevantTargets } from '../intel/ast-repo-map';
import {
  buildImmutableZoneAPrefix,
  buildNonToolFallbackGuide,
  buildStructuredTurnMemory,
  estimateTokens,
  packThreeZoneContext,
  type StepHistoryItem,
} from '../intel/context-packer';
import {
  extractMentionedPathsFromText,
  RepoIndexer,
  type RepoIndex,
} from '../intel/repo-indexer';
import type { TreeSitterService } from '../intel/tree-sitter-service';
import type { McpManager } from '../mcp/mcp-manager';
import {
  repairAndParseToolArgs,
  repairJsonString,
  type OllamaChatMessage,
  type OllamaClient,
  type ParsedToolCall,
} from '../ollama/client';
import { getEffortProfile } from '../ollama/effort-profiles';
import type { TurnPriority, VramScheduler } from '../ollama/vram-scheduler';
import type { SmolCodeStore } from '../store/database';
import type { SnapshotManager } from '../store/snapshots';
import {
  discoverSkills,
  formatSkillCatalogForPrompt,
  loadWorkspaceAgentsPrompt,
  readSkillDetail,
  saveSkillFile,
} from '../tools/agents-skills';
import {
  extractCodePasteBlocks,
  StreamingCodeTagFilter,
  type ParsedCodePasteBlock,
  type TagPreviewInfo,
} from '../tools/code-paste';
import {
  normalizeHashlineEdits,
  resolveInsideWorkdir,
  runCreateFile,
  runDeleteFile,
  runFindFiles,
  runListDir,
  runMoveFile,
  runPatchFile,
  runReadRange,
  runReadSymbol,
  runReplaceLineRange,
  runReplaceSymbolPaste,
  runRepoSearch,
  runWriteFilePaste,
} from '../tools/fs-tools';
import { commandNeedsApproval, executeSandboxedCommand } from '../tools/shell-tools';
import { runLocalImageGeneration } from '../tools/image-gen';
import {
  buildToolListForThread,
  FAST_SCOUT_SCHEMA,
  READ_ONLY_TOOL_NAMES,
} from '../tools/tool-registry';
import { runStageBVerification } from '../tools/verify-gate';
import { runObscuraLookup } from '../tools/web-tools';
import { LoopGuard } from './loop-guard';

interface ZoneACache {
  systemPrompt: string;
  prefixHash: string;
  prefixTokens: number;
  interactionMode: ThreadRecord['interactionMode'];
  mainModel: string;
  agentsHash: string;
  toolsHash: string;
  mcpHash: string;
  structureVersion: number;
  skillsHash: string;
  webLookupEnabled: boolean;
  toolsCapable: boolean;
  hasActivePlan: boolean;
}

interface ScoutPlan {
  targets: Array<{
    filePath: string;
    symbolName?: string;
    startLine?: number;
    endLine?: number;
  }>;
  searchQueries: string[];
  directAnswerPossible: boolean;
}

function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  if (name === 'list_dir') return String(args.dirPath ?? '.');
  if (name === 'find_files') return String(args.pattern ?? '*');
  if (name === 'web_lookup') return String(args.url ?? args.query ?? 'lookup');
  if (name === 'read_skill') return `/${String(args.name ?? '')}`;
  if (name === 'save_skill') return `/${String(args.name ?? '')} (${String(args.scope ?? 'repo')})`;
  if (name === 'generate_image') return String(args.prompt ?? 'image').slice(0, 60);
  if (name === 'repo_search') return `"${String(args.query ?? '')}"`;
  if (name === 'read_symbol')
    return `${String(args.filePath ?? '')}::${String(args.symbolName ?? '')}`;
  if (name === 'read_range')
    return `${String(args.filePath ?? '')} L${String(args.startLine ?? 1)}-${String(args.endLine ?? 60)}`;
  if (name === 'patch_file' || name === 'patch_hashline') return String(args.filePath ?? '');
  if (name === '__code_paste_write') return String(args.filePath ?? '');
  if (name === '__code_paste_symbol')
    return `${String(args.filePath ?? '')}::${String(args.symbolName ?? '')}`;
  if (name === '__code_paste_range')
    return `${String(args.filePath ?? '')} L${String(args.startLine ?? 1)}-${String(args.endLine ?? 1)}`;
  if (name === 'create_file' || name === 'delete_file') return String(args.filePath ?? '');
  if (name === 'move_file') return `${String(args.fromPath ?? '')} -> ${String(args.toPath ?? '')}`;
  if (name === 'run_command') return String(args.command ?? '');
  if (name === 'propose_plan') return String(args.title ?? 'Implementation plan');
  if (name === 'update_plan_step') return `${String(args.stepId ?? '')} -> ${String(args.status ?? '')}`;
  if (name === 'request_user_input') return String(args.question ?? 'Clarifying question');
  if (name === 'finish_turn') return 'verify & summarize';
  return JSON.stringify(args).slice(0, 80);
}

function extractFallbackToolCalls(
  content: string,
  thinking?: string,
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  const pushJsonTool = (rawJson: string) => {
    try {
      const repaired = repairJsonString(rawJson);
      const parsed = JSON.parse(repaired) as {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
      if (parsed.name && typeof parsed.name === 'string') {
        const argParsed = repairAndParseToolArgs(parsed.arguments ?? {});
        calls.push({
          name: parsed.name.trim(),
          arguments: argParsed.args,
          ...(argParsed.parseError ? { parseError: argParsed.parseError } : {}),
        });
      }
    } catch {
      // Ignore malformed inline payload
    }
  };

  const scanText = (source: string) => {
    // 1. <tool_call>...</tool_call>
    for (const m of source.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
      pushJsonTool(m[1]);
    }
    if (calls.length > 0) return;

    // 2. Unclosed <tool_call>{...} when generation truncated at end
    const unclosedMatch = source.match(/<tool_call>\s*(\{[\s\S]+)$/i);
    if (unclosedMatch) {
      pushJsonTool(unclosedMatch[1]);
    }
    if (calls.length > 0) return;

    // 3. Qwen XML format: <function=name><parameter=key>value</parameter>...</function>
    for (const m of source.matchAll(/<function=([a-zA-Z0-9_-]+)>([\s\S]*?)<\/function>/gi)) {
      const args: Record<string, unknown> = {};
      for (const pm of m[2].matchAll(/<parameter=([a-zA-Z0-9_-]+)>([\s\S]*?)<\/parameter>/gi)) {
        const rawVal = pm[2].trim();
        if (rawVal.startsWith('{') || rawVal.startsWith('[')) {
          try {
            args[pm[1]] = JSON.parse(repairJsonString(rawVal));
            continue;
          } catch {
            // Fall back to string value
          }
        }
        args[pm[1]] = rawVal;
      }
      calls.push({ name: m[1].trim(), arguments: args });
    }
    if (calls.length > 0) return;

    // 4. Mistral [TOOL_CALLS] [...]
    const mistralMatch = source.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/i);
    if (mistralMatch) {
      try {
        const arr = JSON.parse(repairJsonString(mistralMatch[1])) as Array<{
          name?: string;
          arguments?: Record<string, unknown> | string;
        }>;
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item?.name) {
              const argParsed = repairAndParseToolArgs(item.arguments ?? {});
              calls.push({
                name: item.name,
                arguments: argParsed.args,
                ...(argParsed.parseError ? { parseError: argParsed.parseError } : {}),
              });
            }
          }
        }
      } catch {
        // Ignore malformed Mistral array
      }
    }
    if (calls.length > 0) return;

    // 5. Fenced JSON tool blocks
    for (const m of source.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/gi)) {
      pushJsonTool(m[1]);
    }
    if (calls.length > 0) return;

    // 6. Naked top-level JSON object {"name": "...", "arguments": {...}}
    const trimmed = source.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"name"') && trimmed.includes('"arguments"')) {
      pushJsonTool(trimmed);
    }
  };

  scanText(content);
  if (calls.length === 0 && thinking?.trim()) {
    scanText(thinking);
  }
  return calls;
}

function parseFlexibleLineNumber(val: unknown): number | undefined {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? Math.floor(val) : undefined;
  }
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/^#?(?:line\s+|l(?=\d))/i, '').split(':')[0];
    const num = Number(cleaned);
    return Number.isFinite(num) ? Math.floor(num) : undefined;
  }
  return undefined;
}

function normalizeToolArguments(
  toolName: string,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...rawArgs };

  if (args.filePath === undefined) {
    const alias = args.path ?? args.file_path ?? args.file ?? args.targetPath;
    if (alias !== undefined) args.filePath = alias;
  }
  if (toolName === 'move_file') {
    if (args.fromPath === undefined) {
      const alias = args.from ?? args.source ?? args.src ?? args.oldPath;
      if (alias !== undefined) args.fromPath = alias;
    }
    if (args.toPath === undefined) {
      const alias = args.to ?? args.dest ?? args.destination ?? args.newPath;
      if (alias !== undefined) args.toPath = alias;
    }
  }
  if (toolName === 'read_symbol' && args.symbolName === undefined) {
    const alias = args.symbol ?? args.name;
    if (alias !== undefined) args.symbolName = alias;
  }
  if (toolName === 'read_range') {
    const rawStart = args.startLine ?? args.start ?? args.start_line ?? args.fromLine;
    const parsedStart = parseFlexibleLineNumber(rawStart);
    if (parsedStart !== undefined) args.startLine = parsedStart;
    else delete args.startLine;

    const rawEnd = args.endLine ?? args.end ?? args.end_line ?? args.toLine;
    const parsedEnd = parseFlexibleLineNumber(rawEnd);
    if (parsedEnd !== undefined) args.endLine = parsedEnd;
    else delete args.endLine;
  }
  if (toolName === 'run_command' && args.command === undefined && args.cmd !== undefined) {
    args.command = args.cmd;
  }
  if (toolName === 'create_file' && args.content === undefined) {
    const alias = args.code ?? args.text ?? args.body ?? args.source;
    if (alias !== undefined) args.content = alias;
  }
  if (toolName === 'patch_file' || toolName === 'patch_hashline') {
    if (args.oldText === undefined) {
      const alias = args.old_text ?? args.old ?? args.search ?? args.find ?? args.before;
      if (alias !== undefined) args.oldText = alias;
    }
    if (args.newText === undefined) {
      const alias = args.new_text ?? args.new ?? args.replace ?? args.replacement ?? args.after;
      if (alias !== undefined) args.newText = alias;
    }
    if (typeof args.edits === 'string') {
      try {
        const parsed = JSON.parse(repairJsonString(args.edits));
        if (Array.isArray(parsed)) args.edits = parsed;
        else if (parsed && typeof parsed === 'object') args.edits = [parsed];
      } catch {
        // Leave unparseable string to fail cleanly in runPatchFile
      }
    } else if (args.edits && typeof args.edits === 'object' && !Array.isArray(args.edits)) {
      args.edits = [args.edits];
    } else if (args.edits === undefined) {
      const hasTopAnchor =
        args.startAnchor ??
        args.start_anchor ??
        args.startLine ??
        args.start_line ??
        args.anchor ??
        args.line ??
        args.start ??
        args.range;
      if (hasTopAnchor !== undefined) {
        args.edits = [
          {
            op: args.op ?? args.operation ?? 'replace_range',
            startAnchor: hasTopAnchor,
            ...(args.endAnchor ?? args.end_anchor ?? args.endLine ?? args.end_line ?? args.end
              ? {
                  endAnchor:
                    args.endAnchor ?? args.end_anchor ?? args.endLine ?? args.end_line ?? args.end,
                }
              : {}),
            ...(args.content ?? args.newContent ?? args.text ?? args.code ?? args.newText
              ? {
                  content:
                    args.content ?? args.newContent ?? args.text ?? args.code ?? args.newText,
                }
              : {}),
          },
        ];
      }
    }
  }
  return args;
}

function buildHeuristicThreadTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New thread';
  const words = cleaned.split(' ').slice(0, 6).join(' ');
  return words.length > 48 ? `${words.slice(0, 45)}...` : words;
}

export class AgentOrchestrator {
  private readonly indexer: RepoIndexer;
  private zoneACacheByThread = new Map<string, ZoneACache>();
  private activeControllers = new Map<string, AbortController>();
  private steeringQueues = new Map<string, string[]>();
  private sessionApprovedCmds = new Map<string, Set<string>>();
  private sessionApprovedOutsideDirs = new Map<string, Set<string>>();
  private pendingApprovals = new Map<
    string,
    { threadId: string; resolve: (decision: ApprovalDecision) => void }
  >();
  private pendingQuestions = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      resolve: (payload: {
        answers: string[];
        answersByQuestion?: Record<string, string[]>;
      }) => void;
    }
  >();
  private modelInfoCache = new Map<string, OllamaModelInfo>();
  private listeners = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    private readonly store: SmolCodeStore,
    private readonly snapshots: SnapshotManager,
    private readonly ollama: OllamaClient,
    private readonly scheduler: VramScheduler,
    private readonly treeSitter: TreeSitterService,
    private readonly mcp?: McpManager,
  ) {
    this.indexer = new RepoIndexer(treeSitter, store);
    this.scheduler.onQueueChange((state) => {
      this.emit({ type: 'queue_updated', ...state });
    });
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.indexer.closeAllWatchers();
  }

  private emit(event: AgentStreamEvent): void {
    for (const cb of this.listeners) {
      cb(event);
    }
  }

  private setThreadStatus(threadId: string, status: ThreadStatus): void {
    this.store.updateThread(threadId, { status });
    this.emit({ type: 'thread_status', threadId, status });
  }

  async refreshModelCatalog(): Promise<OllamaModelInfo[]> {
    const models = await this.ollama.listModels();
    this.modelInfoCache.clear();
    for (const m of models) {
      this.modelInfoCache.set(m.name, m);
    }
    return models;
  }

  private async getModelInfo(modelName: string): Promise<OllamaModelInfo | undefined> {
    if (this.modelInfoCache.has(modelName)) {
      return this.modelInfoCache.get(modelName);
    }
    const caps = await this.ollama.inspectModel(modelName);
    const info: OllamaModelInfo = {
      name: modelName,
      sizeBytes: 0,
      parameterSize: 'unknown',
      quantizationLevel: 'unknown',
      capabilities: caps.capabilities,
      contextLength: caps.contextLength,
    };
    this.modelInfoCache.set(modelName, info);
    return info;
  }

  steerThread(threadId: string, content: string, chips?: ComposerChip[]): void {
    const note = this.formatPromptWithChips(content, chips);
    const existing = this.steeringQueues.get(threadId) ?? [];
    existing.push(note);
    this.steeringQueues.set(threadId, existing);
  }

  stopThread(threadId: string): void {
    this.activeControllers.get(threadId)?.abort();
    // Deny any waiting approval or question so promise resolves cleanly
    for (const [reqId, pending] of this.pendingApprovals) {
      if (pending.threadId === threadId) {
        this.pendingApprovals.delete(reqId);
        pending.resolve('deny');
      }
    }
    for (const [qId, pending] of this.pendingQuestions) {
      if (pending.threadId === threadId) {
        this.pendingQuestions.delete(qId);
        pending.resolve({ answers: ['(Cancelled by user)'] });
      }
    }
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    pending.resolve(decision);
  }

  answerQuestionPrompt(
    threadId: string,
    turnId: string,
    promptId: string,
    answers: string[],
    answersByQuestion?: Record<string, string[]>,
  ): void {
    const turns = this.store.listTurns(threadId);
    const target = turns.find((t) => t.id === turnId);
    if (target?.questionPrompt && target.questionPrompt.id === promptId) {
      this.store.updateTurn(turnId, {
        questionPrompt: {
          ...target.questionPrompt,
          answer: answers,
          ...(answersByQuestion ? { answersByQuestion } : {}),
        },
      });
    }
    const pending = this.pendingQuestions.get(promptId);
    if (pending) {
      this.pendingQuestions.delete(promptId);
      pending.resolve({ answers, answersByQuestion });
    }
  }

  invalidateAfterRestore(
    threadId: string,
    workdir: string,
    changedPaths: string[],
    updatedThread?: ThreadRecord,
  ): void {
    this.zoneACacheByThread.delete(threadId);
    for (const relPath of changedPaths) {
      this.indexer.markDirty(workdir, relPath, true);
    }
    if (changedPaths.length === 0) {
      this.indexer.markDirty(workdir, '.', true);
    }
    if (updatedThread) {
      this.emit({ type: 'thread_updated', thread: updatedThread });
    }
  }

  enqueuePrompt(threadId: string, content: string, chips: ComposerChip[] = []): ThreadRecord {
    const current = this.store.getThread(threadId);
    if (!current) throw new Error(`Thread not found: ${threadId}`);
    const nextQueue = [
      ...(current.queuedPrompts ?? []),
      { id: randomUUID(), content, chips, createdAt: Date.now() },
    ];
    const updated = this.store.updateThread(threadId, { queuedPrompts: nextQueue });
    this.emit({ type: 'thread_updated', thread: updated });
    return updated;
  }

  removeQueuedPrompt(threadId: string, queueId: string): ThreadRecord {
    const current = this.store.getThread(threadId);
    if (!current) throw new Error(`Thread not found: ${threadId}`);
    const nextQueue = (current.queuedPrompts ?? []).filter((q) => q.id !== queueId);
    const updated = this.store.updateThread(threadId, { queuedPrompts: nextQueue });
    this.emit({ type: 'thread_updated', thread: updated });
    return updated;
  }

  async approvePlanAndBuild(threadId: string, turnId: string): Promise<void> {
    const turns = this.store.listTurns(threadId);
    const target = turns.find((t) => t.id === turnId);
    if (target?.plan) {
      this.store.updateTurn(turnId, {
        plan: { ...target.plan, approved: true },
      });
    }
    const updated = this.store.updateThread(threadId, { interactionMode: 'build' });
    this.emit({ type: 'thread_updated', thread: updated });
    await this.runUserTurn({
      threadId,
      content: target?.plan
        ? `Implement the approved plan "${target.plan.title}" cleanly step by step, verifying your changes before finishing.`
        : 'Implement the approved plan step by step.',
    });
  }

  async compactThread(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const turns = this.store.listTurns(threadId);
    if (turns.length <= 1) return;

    const transcript = turns
      .map((t) => `${t.role.toUpperCase()}: ${t.content.slice(0, 500)}`)
      .join('\n\n')
      .slice(0, 8000);

    let summaryText = `Compacted ${turns.length} earlier turns. Recent context:\n${turns
      .slice(-3)
      .map((t) => `- ${t.role}: ${t.content.slice(0, 180)}`)
      .join('\n')}`;

    try {
      const settings = this.store.getSettings();
      const fastInfo = thread.fastModel ? await this.getModelInfo(thread.fastModel) : undefined;
      const opts = this.scheduler.resolveRoleOptions({
        role: 'fast',
        fastModel: thread.fastModel || thread.mainModel,
        mainModel: thread.mainModel,
        effort: thread.effort,
        settings,
        modelInfo: fastInfo,
      });
      if (opts.model) {
        const resp = await this.ollama.chatStream({
          model: opts.model,
          think: false,
          keep_alive: opts.keepAlive,
          options: opts.options,
          messages: [
            {
              role: 'system',
              content:
                'Summarize this coding session into a concise working-memory handoff (key goals, modified files, decisions, remaining work). Max 200 words.',
            },
            { role: 'user', content: transcript },
          ],
        });
        if (resp.content.trim()) {
          summaryText = `**Compacted Thread Context**\n\n${resp.content.trim()}`;
        }
      }
    } catch {
      // Keep deterministic fallback summary
    }

    const summaryTurn: TurnRecord = {
      id: randomUUID(),
      threadId,
      role: 'assistant',
      content: summaryText,
      createdAt: Date.now(),
    };
    this.store.replaceTurnsWithCompactSummary(threadId, summaryTurn);
    this.zoneACacheByThread.delete(threadId);
    this.emit({ type: 'turn_created', threadId, turn: summaryTurn });
  }

  private requestUserApproval(req: Omit<ApprovalRequest, 'id'>): Promise<ApprovalDecision> {
    const id = randomUUID();
    const full: ApprovalRequest = { id, ...req };
    const promise = new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(id, { threadId: req.threadId, resolve });
    });
    this.setThreadStatus(req.threadId, 'awaiting_approval');
    this.emit({ type: 'approval_requested', request: full });
    return promise;
  }

  private async ensureFileWriteAllowed(params: {
    thread: ThreadRecord;
    workdir: string;
    toolName: 'patch_file' | 'patch_hashline' | 'create_file' | 'delete_file' | 'move_file';
    targetPaths: string[];
  }): Promise<
    | { allowed: true; allowOutsideRoot: boolean }
    | { allowed: false; deniedOutput: string }
  > {
    if (params.thread.approvalPolicy === 'read-only') {
      return {
        allowed: false,
        deniedOutput: 'Blocked: thread approval policy is set to read-only.',
      };
    }

    const resolved = params.targetPaths.map((p) => resolveInsideWorkdir(params.workdir, p));
    const external = resolved.filter((r) => !r.inside);
    if (external.length === 0) {
      return { allowed: true, allowOutsideRoot: false };
    }

    if (params.thread.approvalPolicy === 'full-access') {
      return { allowed: true, allowOutsideRoot: true };
    }

    let approvedDirs = this.sessionApprovedOutsideDirs.get(params.thread.id);
    const externalDirs = Array.from(new Set(external.map((e) => dirname(e.absPath))));
    const allDirsApproved =
      approvedDirs !== undefined && externalDirs.every((dir) => approvedDirs!.has(dir));

    if (!allDirsApproved) {
      const actionLabel =
        params.toolName === 'create_file'
          ? 'Create file'
          : params.toolName === 'delete_file'
            ? 'Delete file'
            : params.toolName === 'move_file'
              ? 'Move file'
              : 'Modify file';
      const decision = await this.requestUserApproval({
        threadId: params.thread.id,
        kind: 'write_outside_root',
        title: `${actionLabel} outside workspace`,
        commandOrPath: external.map((e) => e.absPath).join(' -> '),
        cwd: params.workdir,
        reason: 'Target path is outside the active workspace root.',
      });
      this.setThreadStatus(params.thread.id, 'thinking');
      if (decision === 'deny') {
        return {
          allowed: false,
          deniedOutput: `User denied ${params.toolName} outside active workspace: ${external.map((e) => e.absPath).join(', ')}`,
        };
      }
      if (decision === 'allow-session') {
        if (!approvedDirs) {
          approvedDirs = new Set<string>();
          this.sessionApprovedOutsideDirs.set(params.thread.id, approvedDirs);
        }
        for (const dir of externalDirs) {
          approvedDirs.add(dir);
        }
      }
    }

    return { allowed: true, allowOutsideRoot: true };
  }

  private formatPromptWithChips(content: string, chips?: ComposerChip[]): string {
    if (!chips || chips.length === 0) return content;
    const notes: string[] = [];
    for (const chip of chips) {
      if (chip.kind === 'comment' && chip.filePath) {
        notes.push(
          `[Inline review comment on ${chip.filePath}:${chip.startLine ?? 1}-${chip.endLine ?? chip.startLine ?? 1}]: ${chip.body ?? chip.label}`,
        );
      } else if (chip.kind === 'symbol' && chip.filePath && chip.symbolName) {
        notes.push(`[Pinned symbol: ${chip.filePath}::${chip.symbolName}]`);
      } else if (chip.kind === 'file' && chip.filePath) {
        notes.push(`[Pinned file: ${chip.filePath}]`);
      } else if (chip.kind === 'skill' && (chip.skillName || chip.label)) {
        notes.push(`[Active skill: /${(chip.skillName ?? chip.label).replace(/^\/+/, '')}]`);
      }
    }
    return notes.length > 0 ? `${content}\n\n${notes.join('\n')}` : content;
  }

  async searchSymbolsAndFiles(
    projectId: string,
    query: string,
  ) {
    const project = this.store.getProject(projectId);
    if (!project) return [];
    const index = await this.indexer.buildIndex(projectId, project.rootPath);
    return this.indexer.searchSuggestions(index, query, 20);
  }

  async runUserTurn(params: {
    threadId: string;
    content: string;
    chips?: ComposerChip[];
    priority?: TurnPriority;
  }): Promise<void> {
    const thread = this.store.getThread(params.threadId);
    if (!thread) throw new Error(`Thread not found: ${params.threadId}`);
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new Error(`Project not found: ${thread.projectId}`);

    const workdir = project.rootPath;

    const userTurn: TurnRecord = {
      id: randomUUID(),
      threadId: thread.id,
      role: 'user',
      content: params.content,
      chips: params.chips,
      createdAt: Date.now(),
    };
    this.store.insertTurn(userTurn);
    this.emit({ type: 'turn_created', threadId: thread.id, turn: userTurn });

    // Clear draft once submitted
    this.store.updateThread(thread.id, { draftText: '', draftChips: [] });

    const assistantTurn: TurnRecord = {
      id: randomUUID(),
      threadId: thread.id,
      role: 'assistant',
      content: '',
      thinking: '',
      toolCalls: [],
      createdAt: Date.now(),
    };
    this.store.insertTurn(assistantTurn);
    this.emit({ type: 'turn_created', threadId: thread.id, turn: assistantTurn });

    this.setThreadStatus(thread.id, 'queued');

    await this.scheduler.enqueueTurn(
      thread.id,
      params.priority ?? 0,
      async () => {
        await this.executeFourStageTurn({
          thread: this.store.getThread(thread.id) ?? thread,
          projectRoot: project.rootPath,
          workdir,
          userPrompt: params.content,
          chips: params.chips ?? [],
          assistantTurn,
        });
      },
    );
  }

  private async executeFourStageTurn(params: {
    thread: ThreadRecord;
    projectRoot: string;
    workdir: string;
    userPrompt: string;
    chips: ComposerChip[];
    assistantTurn: TurnRecord;
  }): Promise<void> {
    const { thread, workdir, assistantTurn } = params;
    const ac = new AbortController();
    this.activeControllers.set(thread.id, ac);
    const settings = this.store.getSettings();
    const profile = getEffortProfile(thread.effort);
    const loopGuard = new LoopGuard();

    const ledger: WorkingMemoryLedger = {
      goal: params.userPrompt.slice(0, 220),
      inspectedSymbols: [],
      modifiedFiles: [],
      activeErrors: [],
      verifiedChecks: [],
    };

    const toolLogs: ToolCallLog[] = [];
    let tokensSavedByAst = 0;
    let tokensSavedByHashline = 0;
    let tokensSavedByFolding = 0;
    let totalPromptEvalTokens = 0;
    let totalPromptEvalMs = 0;
    let totalEvalTokens = 0;
    let totalEvalMs = 0;
    let scoutMs = 0;
    let verifyMs = 0;

    try {
      // Capture git-independent pre-turn shadow snapshot
      const snapshotId = this.snapshots.captureSnapshot(thread.id, workdir);
      this.store.updateTurn(assistantTurn.id, { snapshotId });

      // ================================================================
      // STAGE 1: Deterministic Prefetch & AST Repo Map (0 LLM tokens)
      // ================================================================
      const tPrefetch = Date.now();
      const index = await this.indexer.buildIndex(thread.projectId, workdir);

      const seedFiles = new Set<string>(
        extractMentionedPathsFromText(params.userPrompt, index),
      );
      for (const chip of params.chips) {
        if (chip.filePath) seedFiles.add(chip.filePath);
      }

      const mcpServers = this.store.listMcpServers().filter((s) => s.enabled);
      const mcpHash = mcpServers.map((s) => `${s.id}:${s.tools?.length ?? 0}`).join('|');

      let resolvedMainModel = thread.mainModel;
      let resolvedFastModel = thread.fastModel;
      if (!resolvedMainModel || !resolvedFastModel) {
        try {
          const catalog = await this.refreshModelCatalog();
          const fallbackModel = catalog[0]?.name ?? '';
          resolvedMainModel = resolvedMainModel || settings.defaultMainModel || fallbackModel;
          resolvedFastModel = resolvedFastModel || settings.defaultFastModel || resolvedMainModel;
        } catch {
          resolvedMainModel = resolvedMainModel || settings.defaultMainModel;
          resolvedFastModel = resolvedFastModel || settings.defaultFastModel || resolvedMainModel;
        }
      }

      const fastModelInfo = resolvedFastModel ? await this.getModelInfo(resolvedFastModel) : undefined;
      const mainModelInfo = resolvedMainModel ? await this.getModelInfo(resolvedMainModel) : undefined;
      const toolsCapable = mainModelInfo?.capabilities.tools !== false;
      const webLookupEnabled = settings.webLookupEnabled !== false;
      const activePlanEntry =
        thread.interactionMode === 'build' ? this.findLatestApprovedPlan(thread.id) : null;
      const hasActivePlan = Boolean(activePlanEntry);
      const structureVersion = this.indexer.getStructureVersion(workdir);
      const availableSkills = discoverSkills(params.projectRoot);
      const skillCatalog = formatSkillCatalogForPrompt(availableSkills, 1600);
      const skillsHash = createHash('sha1').update(skillCatalog).digest('hex').slice(0, 12);
      const agentsPrompt = loadWorkspaceAgentsPrompt(params.projectRoot);
      const agentsHash = createHash('sha1').update(agentsPrompt).digest('hex').slice(0, 12);
      const hasSkillChips = params.chips.some((c) => c.kind === 'skill');
      const hasImageGenSkill = params.chips.some(
        (c) => c.kind === 'skill' && (c.skillName ?? c.label).replace(/^\/+/, '').toLowerCase() === 'image-gen',
      );

      const threadTools = buildToolListForThread(thread.interactionMode, mcpServers, {
        webLookupEnabled,
        hasActivePlan,
        userPrompt: params.userPrompt,
        hasSkillChips,
        hasImageGenSkill,
      });
      const toolsHash = createHash('sha1')
        .update(JSON.stringify(threadTools))
        .digest('hex')
        .slice(0, 12);

      // Build or reuse KV-Cache-Locked Zone A prefix (refreshed incrementally across turns
      // only when repo structure, mode, model, AGENTS.md, skills, or toolset change).
      // Repo skeleton in Zone A stays unseeded so Turn 1..N share the exact same prefix.
      let zoneA = this.zoneACacheByThread.get(thread.id);
      let kvPrefixReused = false;
      if (
        !zoneA ||
        zoneA.interactionMode !== thread.interactionMode ||
        zoneA.mainModel !== resolvedMainModel ||
        zoneA.agentsHash !== agentsHash ||
        zoneA.toolsHash !== toolsHash ||
        zoneA.mcpHash !== mcpHash ||
        zoneA.structureVersion !== structureVersion ||
        zoneA.skillsHash !== skillsHash ||
        zoneA.webLookupEnabled !== webLookupEnabled ||
        zoneA.toolsCapable !== toolsCapable ||
        zoneA.hasActivePlan !== hasActivePlan
      ) {
        const skeleton = buildAstRepoSkeleton(index, [], 4600);
        tokensSavedByAst += skeleton.estimatedTokensSaved;
        const nonToolFallbackGuide = toolsCapable
          ? undefined
          : buildNonToolFallbackGuide(threadTools);
        const built = buildImmutableZoneAPrefix({
          agentsPrompt,
          repoSkeleton: skeleton.skeleton,
          toolDefs: threadTools,
          interactionMode: thread.interactionMode,
          nonToolFallbackGuide,
          skillCatalog,
        });
        zoneA = {
          ...built,
          interactionMode: thread.interactionMode,
          mainModel: resolvedMainModel,
          agentsHash,
          toolsHash,
          mcpHash,
          structureVersion,
          skillsHash,
          webLookupEnabled,
          toolsCapable,
          hasActivePlan,
        };
        this.zoneACacheByThread.set(thread.id, zoneA);
      } else {
        kvPrefixReused = true;
      }

      // Deterministic prefetch of explicit chip targets, skills, AND prompt-mentioned seed files
      const prefetchedSlices: string[] = [];
      const prefetchedFiles = new Set<string>();
      const prefetchedSkillNames = new Set<string>();
      const emitPrefetchTool = (
        toolName: 'read_symbol' | 'read_range' | 'read_skill',
        filePath: string | undefined,
        summary: string,
        resultPreview: string,
        durationMs: number,
      ) => {
        const entry: ToolCallLog = {
          id: randomUUID(),
          toolName,
          summary,
          argsPreview: summary,
          resultPreview: resultPreview.slice(0, 200),
          status: 'ok',
          durationMs,
          filePath,
        };
        toolLogs.push(entry);
        this.emit({
          type: 'tool_update',
          threadId: thread.id,
          turnId: assistantTurn.id,
          tool: entry,
        });
      };

      for (const chip of params.chips) {
        if (chip.kind === 'skill' && (chip.skillName || chip.label)) {
          const skName = (chip.skillName ?? chip.label).replace(/^\/+/, '');
          if (!prefetchedSkillNames.has(skName.toLowerCase())) {
            const tSk = Date.now();
            const detail = readSkillDetail(availableSkills, skName);
            if (detail.found && detail.skill) {
              prefetchedSkillNames.add(detail.skill.name.toLowerCase());
              prefetchedSlices.push(detail.output);
              ledger.inspectedSymbols.push(`skill:${detail.skill.name}`);
              emitPrefetchTool(
                'read_skill',
                undefined,
                `/${detail.skill.name}`,
                detail.output,
                Date.now() - tSk,
              );
            }
          }
        } else if (chip.kind === 'symbol' && chip.filePath && chip.symbolName) {
          const tRead = Date.now();
          try {
            const slice = runReadSymbol(index, this.indexer, chip.filePath, chip.symbolName);
            prefetchedSlices.push(slice.output);
            tokensSavedByAst += slice.tokensSavedApprox;
            ledger.inspectedSymbols.push(`${chip.filePath}::${chip.symbolName}`);
            prefetchedFiles.add(chip.filePath);
            emitPrefetchTool(
              'read_symbol',
              chip.filePath,
              `${chip.filePath}::${chip.symbolName}`,
              slice.output,
              Date.now() - tRead,
            );
          } catch {
            // Ignore stale symbol chip
          }
        } else if (
          (chip.kind === 'comment' || chip.kind === 'file') &&
          chip.filePath
        ) {
          const tRead = Date.now();
          try {
            const start = Math.max(1, (chip.startLine ?? 1) - 10);
            const end = (chip.endLine ?? chip.startLine ?? 1) + 25;
            const slice = runReadRange(workdir, chip.filePath, start, end);
            prefetchedSlices.push(slice.output);
            tokensSavedByAst += slice.tokensSavedApprox;
            ledger.inspectedSymbols.push(`${chip.filePath}:L${start}-${end}`);
            prefetchedFiles.add(chip.filePath);
            emitPrefetchTool(
              'read_range',
              chip.filePath,
              `${chip.filePath} L${start}-${end}`,
              slice.output,
              Date.now() - tRead,
            );
          } catch {
            // Ignore missing file chip
          }
        }
      }

      for (const seedPath of [...seedFiles].slice(0, 3)) {
        if (prefetchedFiles.has(seedPath)) continue;
        const tRead = Date.now();
        try {
          const info = index.files.get(seedPath);
          const endLine = info && info.lineCount > 0 && info.lineCount <= 120 ? info.lineCount : 90;
          const slice = runReadRange(workdir, seedPath, 1, endLine);
          prefetchedSlices.push(slice.output);
          tokensSavedByAst += slice.tokensSavedApprox;
          ledger.inspectedSymbols.push(`${seedPath}:L1-${endLine}`);
          prefetchedFiles.add(seedPath);
          emitPrefetchTool(
            'read_range',
            seedPath,
            `${seedPath} L1-${endLine}`,
            slice.output,
            Date.now() - tRead,
          );
        } catch {
          // Ignore unreadable seed path
        }
      }

      // Also prefetch if user typed /skill-name inline in the prompt
      const inlineSkills = params.userPrompt.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9_-]*)/gi);
      for (const m of inlineSkills) {
        const skName = m[1].toLowerCase();
        if (prefetchedSkillNames.has(skName)) continue;
        const tSk = Date.now();
        const detail = readSkillDetail(availableSkills, skName);
        if (detail.found && detail.skill) {
          prefetchedSkillNames.add(detail.skill.name.toLowerCase());
          prefetchedSlices.push(detail.output);
          ledger.inspectedSymbols.push(`skill:${detail.skill.name}`);
          emitPrefetchTool(
            'read_skill',
            undefined,
            `/${detail.skill.name}`,
            detail.output,
            Date.now() - tSk,
          );
        }
      }
      // Stage 1.5: Deterministic AST + lexical pre-retrieval (0 LLM tokens, <5ms)
      let prefetchedChars = prefetchedSlices.reduce((sum, s) => sum + s.length, 0);
      if (prefetchedFiles.size < 3 && prefetchedChars < 4800 && index.files.size > 0) {
        const autoTargets = retrieveRelevantTargets(
          index,
          params.userPrompt,
          [...seedFiles],
          3,
        );
        for (const tgt of autoTargets) {
          if (prefetchedFiles.has(tgt.filePath) || prefetchedChars >= 4800) continue;
          const tAuto = Date.now();
          try {
            if (tgt.symbolName) {
              const res = runReadSymbol(index, this.indexer, tgt.filePath, tgt.symbolName);
              if (prefetchedChars + res.output.length <= 5400) {
                prefetchedSlices.push(res.output);
                prefetchedChars += res.output.length;
                tokensSavedByAst += res.tokensSavedApprox;
                prefetchedFiles.add(tgt.filePath);
                ledger.inspectedSymbols.push(`${tgt.filePath}::${tgt.symbolName}`);
                emitPrefetchTool(
                  'read_symbol',
                  tgt.filePath,
                  `${tgt.filePath}::${tgt.symbolName}`,
                  res.output,
                  Date.now() - tAuto,
                );
              }
            } else {
              const start = Math.max(1, tgt.startLine ?? 1);
              const end = Math.min(start + 75, tgt.endLine ?? start + 75);
              const res = runReadRange(workdir, tgt.filePath, start, end);
              if (prefetchedChars + res.output.length <= 5400) {
                prefetchedSlices.push(res.output);
                prefetchedChars += res.output.length;
                tokensSavedByAst += res.tokensSavedApprox;
                prefetchedFiles.add(tgt.filePath);
                ledger.inspectedSymbols.push(`${tgt.filePath}:L${start}-${end}`);
                emitPrefetchTool(
                  'read_range',
                  tgt.filePath,
                  `${tgt.filePath} L${start}-${end}`,
                  res.output,
                  Date.now() - tAuto,
                );
              }
            }
          } catch {
            // Ignore transient read errors
          }
        }
      }
      const prefetchMs = Date.now() - tPrefetch;

      // ================================================================
      // STAGE 2: Fast Scout Burst (only when distinct fast model is used and local retrieval < 2 slices)
      // ================================================================
      const useDistinctFastModel =
        Boolean(resolvedFastModel) &&
        (resolvedFastModel !== resolvedMainModel ||
          settings.vramScheduleMode === 'strict-role-split');
      if (
        profile.runFastScout &&
        useDistinctFastModel &&
        !hasImageGenSkill &&
        prefetchedSlices.length < 2 &&
        index.files.size > 0
      ) {
        this.setThreadStatus(thread.id, 'scouting');
        const tScout = Date.now();
        const scoutToolId = randomUUID();
        const scoutLog: ToolCallLog = {
          id: scoutToolId,
          toolName: 'fast_scout',
          summary: `Scouting symbols with ${thread.fastModel}`,
          argsPreview: params.userPrompt.slice(0, 80),
          status: 'running',
        };
        toolLogs.push(scoutLog);
        this.emit({
          type: 'tool_update',
          threadId: thread.id,
          turnId: assistantTurn.id,
          tool: scoutLog,
        });

        try {
          const fastOpts = this.scheduler.resolveRoleOptions({
            role: 'fast',
            fastModel: resolvedFastModel,
            mainModel: resolvedMainModel,
            effort: thread.effort,
            settings,
            modelInfo: fastModelInfo,
          });
          const skeletonOnly = buildAstRepoSkeleton(index, [...seedFiles], 3600);
          tokensSavedByAst += skeletonOnly.estimatedTokensSaved;

          const scoutResp = await this.ollama.chatStream({
            model: fastOpts.model,
            think: fastOpts.think,
            keep_alive: fastOpts.keepAlive,
            options: fastOpts.options,
            format: FAST_SCOUT_SCHEMA,
            signal: ac.signal,
            messages: [
              {
                role: 'system',
                content:
                  'Select up to 4 most relevant file/symbol slices and up to 2 short search queries for the task. Respond strictly in JSON.',
              },
              {
                role: 'user',
                content: `Task: ${params.userPrompt}\n\nRepo Skeleton:\n${skeletonOnly.skeleton}`,
              },
            ],
          });

          totalPromptEvalTokens += scoutResp.promptEvalCount;
          totalPromptEvalMs += scoutResp.promptEvalDurationMs;
          totalEvalTokens += scoutResp.evalCount;
          totalEvalMs += scoutResp.evalDurationMs;

          const plan = JSON.parse(scoutResp.content || '{}') as Partial<ScoutPlan>;
          const loadedTargets: string[] = [];

          for (const tgt of (plan.targets ?? []).slice(0, 4)) {
            if (!tgt.filePath) continue;
            try {
              if (tgt.symbolName) {
                const res = runReadSymbol(index, this.indexer, tgt.filePath, tgt.symbolName);
                prefetchedSlices.push(res.output);
                tokensSavedByAst += res.tokensSavedApprox;
                ledger.inspectedSymbols.push(`${tgt.filePath}::${tgt.symbolName}`);
                loadedTargets.push(`${tgt.filePath}::${tgt.symbolName}`);
              } else {
                const start = Math.max(1, tgt.startLine ?? 1);
                const end = Math.max(start, tgt.endLine ?? start + 75);
                const res = runReadRange(workdir, tgt.filePath, start, end);
                prefetchedSlices.push(res.output);
                tokensSavedByAst += res.tokensSavedApprox;
                ledger.inspectedSymbols.push(`${tgt.filePath}:L${start}-${end}`);
                loadedTargets.push(`${tgt.filePath}:L${start}-${end}`);
              }
            } catch {
              // Ignore hallucinated scout path safely
            }
          }

          for (const q of (plan.searchQueries ?? []).slice(0, 2)) {
            if (!q.trim()) continue;
            const hits = runRepoSearch(index, q, undefined, 12);
            if (!hits.startsWith('No matches')) {
              prefetchedSlices.push(`Search "${q}":\n${hits}`);
            }
          }

          scoutLog.status = 'ok';
          scoutLog.durationMs = Date.now() - tScout;
          scoutLog.resultPreview =
            loadedTargets.length > 0
              ? `Prefetched ${loadedTargets.join(', ')}`
              : 'Skeleton triage complete';
          this.emit({
            type: 'tool_update',
            threadId: thread.id,
            turnId: assistantTurn.id,
            tool: { ...scoutLog },
          });
        } catch {
          scoutLog.status = 'ok';
          scoutLog.durationMs = Date.now() - tScout;
          scoutLog.resultPreview = 'Scout bypassed (fallback to direct search)';
          this.emit({
            type: 'tool_update',
            threadId: thread.id,
            turnId: assistantTurn.id,
            tool: { ...scoutLog },
          });
        }
        scoutMs = Date.now() - tScout;
      }

      // ================================================================
      // STAGE 3: Main Thinker Execution & Self-Verify Loop
      // ================================================================
      this.setThreadStatus(thread.id, 'thinking');
      const mainOpts = this.scheduler.resolveRoleOptions({
        role: 'main',
        fastModel: resolvedFastModel,
        mainModel: resolvedMainModel,
        effort: thread.effort,
        settings,
        modelInfo: mainModelInfo,
      });

      // Include structured multi-turn memory inside prompt seed if multi-turn
      const priorTurns = this.store
        .listTurns(thread.id)
        .filter((t) => t.id !== assistantTurn.id && t.createdAt < assistantTurn.createdAt);
      const memoryTokenBudget = Math.min(1800, Math.floor(mainOpts.options.num_ctx * 0.2));
      const priorContextNote =
        priorTurns.length > 1
          ? buildStructuredTurnMemory(priorTurns.slice(0, -1), memoryTokenBudget)
          : '';

      // If an approved plan exists in Build mode, activate its first pending step and expose step IDs
      let activePlanNote = '';
      if (activePlanEntry) {
        const currentPlan = activePlanEntry.plan;
        const hasInProgress = currentPlan.steps.some((s) => s.status === 'in_progress');
        const firstPending = currentPlan.steps.find((s) => s.status === 'pending');
        if (!hasInProgress && firstPending) {
          this.updatePlanStepStatus(thread.id, activePlanEntry.turnId, firstPending.id, 'in_progress');
        }
        const refreshedPlan = this.findLatestApprovedPlan(thread.id)?.plan ?? currentPlan;
        activePlanNote = [
          `Active Approved Plan "${refreshedPlan.title}":`,
          ...refreshedPlan.steps.map((s) => `- [${s.status}] ${s.id}: ${s.title}`),
        ].join('\n');
      }

      const images = params.chips
        .filter((c) => c.kind === 'image' && c.dataBase64)
        .map((c) => c.dataBase64 as string);

      const promptSections = [
        priorContextNote ? `Previous thread memory:\n${priorContextNote}` : '',
        activePlanNote ? `${activePlanNote}` : '',
        priorContextNote || activePlanNote
          ? `Current request:\n${params.userPrompt}`
          : params.userPrompt,
      ].filter(Boolean);

      const formattedUserPrompt = this.formatPromptWithChips(
        promptSections.join('\n\n'),
        params.chips,
      );

      const steps: StepHistoryItem[] = [];
      let finalAnswer = '';
      let fullThinking = '';
      let activeContextTokens = 0;
      let lastVerifiedEpoch = -1;
      let consecutiveThinkExhaustions = 0;
      let turnThinkOverride: boolean | undefined;
      let anyColdReload = false;
      let stepCount = 0;

      const MAX_TURN_STEPS = 24;
      const tThink = Date.now();

      while (!ac.signal.aborted && stepCount < MAX_TURN_STEPS) {
        stepCount += 1;

        // Drain mid-turn steering notes at the message tail so prefix KV cache stays intact
        const steered = this.steeringQueues.get(thread.id);
        const steeringNotes = steered && steered.length > 0 ? [...steered] : undefined;

        const packed = packThreeZoneContext({
          immutableSystemPrompt: zoneA.systemPrompt,
          prefixHash: zoneA.prefixHash,
          prefixTokens: zoneA.prefixTokens,
          userPrompt: formattedUserPrompt,
          prefetchedContext: prefetchedSlices.join('\n\n'),
          images: mainModelInfo?.capabilities.vision ? images : undefined,
          effortGuidance: profile.guidanceHint,
          ledger,
          steps,
          numCtx: mainOpts.options.num_ctx,
          steeringNotes,
        });

        loopGuard.invalidateFoldedReads(packed.foldedReadCalls);
        activeContextTokens = packed.activeContextTokens;
        tokensSavedByFolding = packed.tokensSavedByFolding;

        let stepThinking = '';
        const livePasteLogs: ToolCallLog[] = [];
        const createTagFilter = () =>
          new StreamingCodeTagFilter(
            (proseDelta) => {
              this.emit({
                type: 'content_delta',
                threadId: thread.id,
                turnId: assistantTurn.id,
                delta: proseDelta,
              });
            },
            (info: TagPreviewInfo) => {
              const summary =
                info.kind === 'replace_symbol' && info.symbolName
                  ? `${info.filePath}::${info.symbolName}`
                  : info.kind === 'replace_range' && info.startLine !== undefined
                    ? `${info.filePath} L${info.startLine}-${info.endLine ?? info.startLine}`
                    : info.filePath || 'file';
              const entry: ToolCallLog = {
                id: randomUUID(),
                toolName: info.kind === 'file_write' ? 'create_file' : 'patch_file',
                summary,
                argsPreview: `<${info.kind}>`,
                status: 'running',
                filePath: info.filePath || undefined,
              };
              livePasteLogs.push(entry);
              toolLogs.push(entry);
              this.emit({
                type: 'tool_update',
                threadId: thread.id,
                turnId: assistantTurn.id,
                tool: entry,
              });
            },
          );
        const mainTagFilter = createTagFilter();

        // Keep think flag consistent across all steps unless thinking exhausted twice.
        const effectiveThink = turnThinkOverride ?? mainOpts.think;
        const stepSignal = AbortSignal.any([ac.signal, AbortSignal.timeout(profile.stepTimeoutMs)]);
        const resp = await this.ollama.chatStream({
          model: mainOpts.model || resolvedMainModel,
          think: effectiveThink,
          keep_alive: mainOpts.keepAlive,
          options: mainOpts.options,
          ...(toolsCapable ? { tools: threadTools } : {}),
          messages: packed.messages as OllamaChatMessage[],
          signal: stepSignal,
          onThinkingDelta: (delta) => {
            stepThinking += delta;
            fullThinking += delta;
            this.emit({
              type: 'thinking_delta',
              threadId: thread.id,
              turnId: assistantTurn.id,
              delta,
            });
          },
          onContentDelta: (delta) => {
            mainTagFilter.push(delta);
          },
        });
        mainTagFilter.flush();

        totalPromptEvalTokens += resp.promptEvalCount;
        totalPromptEvalMs += resp.promptEvalDurationMs;
        totalEvalTokens += resp.evalCount;
        totalEvalMs += resp.evalDurationMs;
        if (resp.loadDurationMs > 250 && stepCount > 1) {
          anyColdReload = true;
        }

        let effectiveContent = resp.content;
        let effectiveThinking = resp.thinking;
        let toolCalls: ParsedToolCall[] =
          resp.toolCalls.length > 0
            ? resp.toolCalls
            : extractFallbackToolCalls(resp.content, resp.thinking);

        // Recovery guard: if a thinking model exhausted num_predict inside <think>
        // before emitting content or tool calls, immediately nudge with think:false.
        if (
          toolCalls.length === 0 &&
          resp.content.trim().length === 0 &&
          resp.thinking.trim().length > 0
        ) {
          consecutiveThinkExhaustions += 1;
          if (consecutiveThinkExhaustions >= 2 && effectiveThink) {
            turnThinkOverride = false;
          }
          const nudgeTagFilter = createTagFilter();
          const nudgeSignal = AbortSignal.any([
            ac.signal,
            AbortSignal.timeout(Math.min(60_000, profile.stepTimeoutMs)),
          ]);
          const nudgeResp = await this.ollama.chatStream({
            model: mainOpts.model || resolvedMainModel,
            think: false,
            keep_alive: mainOpts.keepAlive,
            options: { ...mainOpts.options, num_predict: Math.max(2048, profile.numPredict) },
            ...(toolsCapable ? { tools: threadTools } : {}),
            messages: [
              ...(packed.messages as OllamaChatMessage[]),
              {
                role: 'user',
                content: `Based on your reasoning (${resp.thinking.slice(-600)}), emit the exact tool call, code block (<file_write>/<replace_symbol>/<replace_range>), or final answer now.`,
              },
            ],
            signal: nudgeSignal,
            onContentDelta: (delta) => {
              nudgeTagFilter.push(delta);
            },
          });
          nudgeTagFilter.flush();
          totalPromptEvalTokens += nudgeResp.promptEvalCount;
          totalPromptEvalMs += nudgeResp.promptEvalDurationMs;
          totalEvalTokens += nudgeResp.evalCount;
          totalEvalMs += nudgeResp.evalDurationMs;
          effectiveContent = nudgeResp.content || resp.content;
          effectiveThinking = nudgeResp.thinking || resp.thinking;
          toolCalls =
            nudgeResp.toolCalls.length > 0
              ? nudgeResp.toolCalls
              : extractFallbackToolCalls(nudgeResp.content, nudgeResp.thinking);
          if (toolCalls.length === 0) {
            finalAnswer = nudgeResp.content.trim();
          }
        } else {
          consecutiveThinkExhaustions = 0;
        }

        // Extract raw code-paste blocks (<file_write>, <replace_symbol>, <replace_range>)
        const pasteExtraction = extractCodePasteBlocks(effectiveContent, effectiveThinking);
        const cleanedAssistantContent = pasteExtraction.cleanedContent;
        const preallocatedLogs = new Map<ParsedToolCall, ToolCallLog>();
        const pasteCalls: ParsedToolCall[] = pasteExtraction.blocks.map(
          (block: ParsedCodePasteBlock, idx: number) => {
            const name =
              block.kind === 'file_write'
                ? '__code_paste_write'
                : block.kind === 'replace_symbol'
                  ? '__code_paste_symbol'
                  : '__code_paste_range';
            const tc: ParsedToolCall = {
              name,
              arguments: {
                filePath: block.filePath,
                ...(block.symbolName ? { symbolName: block.symbolName } : {}),
                ...(block.startLine !== undefined ? { startLine: block.startLine } : {}),
                ...(block.endLine !== undefined ? { endLine: block.endLine } : {}),
                content: block.content,
              },
              ...(block.truncationError ? { parseError: block.truncationError } : {}),
            };
            const liveEntry = livePasteLogs[idx];
            if (liveEntry) {
              preallocatedLogs.set(tc, liveEntry);
            }
            return tc;
          },
        );
        const allCalls = [...pasteCalls, ...toolCalls];

        if (allCalls.length === 0) {
          if (!finalAnswer) finalAnswer = cleanedAssistantContent.trim();
          // Run Stage B verification automatically if files were modified since last verify
          const currentEpoch = loopGuard.getMutationEpoch();
          if (
            ledger.modifiedFiles.length > 0 &&
            lastVerifiedEpoch !== currentEpoch &&
            profile.verifyDepth !== 'syntax'
          ) {
            lastVerifiedEpoch = currentEpoch;
            const verifyRes = await this.runAndRecordStageB({
              thread,
              workdir,
              assistantTurnId: assistantTurn.id,
              depth: profile.verifyDepth,
              timeoutMs: profile.verifyTimeoutMs,
              modifiedFiles: ledger.modifiedFiles,
              ledger,
              loopGuard,
              toolLogs,
              steps,
              assistantContent: cleanedAssistantContent,
              signal: ac.signal,
              onVerifyTime: (ms) => {
                verifyMs += ms;
              },
            });
            if (!verifyRes.passed) {
              if (verifyRes.haltReason) {
                finalAnswer = verifyRes.haltReason;
                break;
              }
              // Loop back so the model repairs the detected errors
              finalAnswer = '';
              continue;
            }
          }
          if (activePlanEntry) {
            this.completeActivePlanSteps(thread.id);
          }
          break;
        }

        const stepItem: StepHistoryItem = {
          id: randomUUID(),
          assistantContent: cleanedAssistantContent,
          assistantThinking: stepThinking,
          toolCalls: [],
        };

        let finishRequested: { summary: string } | null = null;
        let stepHadError = false;

        // Normalize arguments before LoopGuard & execution
        const normalizedCalls = allCalls.map((tc) => {
          const normalized = {
            ...tc,
            arguments: normalizeToolArguments(tc.name, tc.arguments),
          };
          const pre = preallocatedLogs.get(tc);
          if (pre) preallocatedLogs.set(normalized, pre);
          return normalized;
        });

        // Partition consecutive safe read-only calls into parallel batches while preserving
        // deterministic ordering in toolLogs and stepItem.toolCalls.
        let cursor = 0;
        while (cursor < normalizedCalls.length && !finalAnswer) {
          const isParallelBatch =
            READ_ONLY_TOOL_NAMES.has(normalizedCalls[cursor].name) &&
            !normalizedCalls[cursor].parseError;

          if (isParallelBatch) {
            const batch: ParsedToolCall[] = [];
            while (
              cursor < normalizedCalls.length &&
              READ_ONLY_TOOL_NAMES.has(normalizedCalls[cursor].name) &&
              !normalizedCalls[cursor].parseError
            ) {
              batch.push(normalizedCalls[cursor]);
              cursor += 1;
            }

            const prepared = batch.map((tc) => {
              const guard = loopGuard.recordToolAttempt(tc.name, tc.arguments);
              const logEntry: ToolCallLog = {
                id: randomUUID(),
                toolName: tc.name,
                summary: summarizeToolArgs(tc.name, tc.arguments),
                argsPreview: JSON.stringify(tc.arguments).slice(0, 140),
                status: 'running',
                filePath:
                  typeof tc.arguments.filePath === 'string'
                    ? tc.arguments.filePath
                    : undefined,
              };
              toolLogs.push(logEntry);
              this.emit({
                type: 'tool_update',
                threadId: thread.id,
                turnId: assistantTurn.id,
                tool: logEntry,
              });
              return { tc, guard, logEntry, startedAt: Date.now() };
            });

            const batchResults = await Promise.all(
              prepared.map(async (item) => {
                if (item.guard.action === 'halt' || item.guard.action === 'pivot') {
                  return { kind: 'guard' as const, item };
                }
                try {
                  const execResult = await this.executeTool({
                    thread,
                    assistantTurnId: assistantTurn.id,
                    projectRoot: params.projectRoot,
                    workdir,
                    index,
                    mcpServers,
                    toolName: item.tc.name,
                    args: item.tc.arguments,
                    ledger,
                    loopGuard,
                    logEntry: item.logEntry,
                    signal: ac.signal,
                  });
                  return { kind: 'ok' as const, item, execResult };
                } catch (error) {
                  return { kind: 'err' as const, item, error };
                }
              }),
            );

            const finalizeRemainingBatchLogs = (fromIdx: number, haltMsg: string) => {
              for (let j = fromIdx; j < batchResults.length; j++) {
                const rem = batchResults[j].item;
                if (rem.logEntry.status === 'running') {
                  rem.logEntry.status = 'error';
                  rem.logEntry.durationMs = Date.now() - rem.startedAt;
                  rem.logEntry.resultPreview = haltMsg;
                  this.emit({
                    type: 'tool_update',
                    threadId: thread.id,
                    turnId: assistantTurn.id,
                    tool: { ...rem.logEntry },
                  });
                }
              }
            };

            for (let idx = 0; idx < batchResults.length; idx++) {
              const res = batchResults[idx];
              const { tc, guard, logEntry, startedAt } = res.item;
              if (res.kind === 'guard') {
                stepHadError = true;
                logEntry.status = 'error';
                logEntry.resultPreview = guard.reason;
                logEntry.durationMs = Date.now() - startedAt;
                this.emit({
                  type: 'tool_update',
                  threadId: thread.id,
                  turnId: assistantTurn.id,
                  tool: { ...logEntry },
                });
                if (guard.action === 'halt') {
                  finalizeRemainingBatchLogs(idx + 1, 'Stopped due to earlier LoopGuard halt.');
                  finalAnswer = `${guard.reason}\n\nPartial progress summary:\n- Modified files: ${ledger.modifiedFiles.join(', ') || 'none'}`;
                  break;
                }
                stepItem.toolCalls.push({
                  name: tc.name,
                  arguments: tc.arguments,
                  result: guard.reason ?? 'Pivot required.',
                });
              } else if (res.kind === 'err') {
                stepHadError = true;
                const errMsg =
                  res.error instanceof Error ? res.error.message : String(res.error);
                logEntry.status = 'error';
                logEntry.durationMs = Date.now() - startedAt;
                logEntry.resultPreview = errMsg.slice(0, 200);
                ledger.activeErrors = [errMsg.slice(0, 400)];
                this.emit({
                  type: 'tool_update',
                  threadId: thread.id,
                  turnId: assistantTurn.id,
                  tool: { ...logEntry },
                });
                const outcomeCheck = loopGuard.recordOutcome(
                  `${tc.name}:${typeof tc.arguments.filePath === 'string' ? tc.arguments.filePath : ''}`,
                  true,
                  errMsg,
                );
                stepItem.toolCalls.push({
                  name: tc.name,
                  arguments: tc.arguments,
                  result: `Tool error: ${errMsg}`,
                });
                if (outcomeCheck.action === 'halt') {
                  finalizeRemainingBatchLogs(idx + 1, 'Stopped due to earlier error halt.');
                  finalAnswer = outcomeCheck.reason ?? 'Stopped after repeated errors.';
                  break;
                }
              } else {
                const { execResult } = res;
                if (execResult.isError || execResult.denied) stepHadError = true;
                logEntry.status = execResult.denied
                  ? 'denied'
                  : execResult.isError
                    ? 'error'
                    : 'ok';
                logEntry.durationMs = Date.now() - startedAt;
                logEntry.resultPreview = execResult.output.slice(0, 200);
                logEntry.filePath = execResult.filePath ?? logEntry.filePath;
                tokensSavedByAst += execResult.tokensSavedByAst ?? 0;
                this.emit({
                  type: 'tool_update',
                  threadId: thread.id,
                  turnId: assistantTurn.id,
                  tool: { ...logEntry },
                });
                const outcomeCheck = loopGuard.recordOutcome(
                  `${tc.name}:${execResult.filePath ?? ''}`,
                  Boolean(execResult.isError),
                  execResult.output,
                );
                stepItem.toolCalls.push({
                  name: tc.name,
                  arguments: tc.arguments,
                  result: execResult.output,
                  isReadOnlySlice: execResult.isReadOnlySlice,
                });
                if (outcomeCheck.action === 'halt') {
                  finalizeRemainingBatchLogs(idx + 1, 'Stopped due to earlier error halt.');
                  finalAnswer = outcomeCheck.reason ?? 'Stopped after repeated errors.';
                  break;
                }
              }
            }
            continue;
          }

          const tc = normalizedCalls[cursor];
          cursor += 1;

          // Surface malformed JSON tool arguments or truncated code-paste tags clearly
          if (tc.parseError) {
            stepHadError = true;
            const existingLog = preallocatedLogs.get(tc);
            const logEntry: ToolCallLog = existingLog ?? {
              id: randomUUID(),
              toolName: tc.name.startsWith('__code_paste_') ? 'patch_file' : tc.name,
              summary: summarizeToolArgs(tc.name, tc.arguments),
              argsPreview: tc.parseError.slice(0, 140),
              resultPreview: tc.parseError.slice(0, 200),
              status: 'error',
              durationMs: 0,
            };
            logEntry.summary = existingLog
              ? logEntry.summary
              : tc.name.startsWith('__code_paste_')
                ? summarizeToolArgs(tc.name, tc.arguments)
                : 'Malformed JSON arguments';
            logEntry.argsPreview = tc.parseError.slice(0, 140);
            logEntry.resultPreview = tc.parseError.slice(0, 200);
            logEntry.status = 'error';
            logEntry.durationMs = 0;
            if (!existingLog) {
              toolLogs.push(logEntry);
            }
            this.emit({
              type: 'tool_update',
              threadId: thread.id,
              turnId: assistantTurn.id,
              tool: { ...logEntry },
            });
            const outcomeCheck = loopGuard.recordOutcome(`json:${tc.name}`, true, tc.parseError);
            stepItem.toolCalls.push({
              name: tc.name,
              arguments: tc.arguments,
              result: tc.name.startsWith('__code_paste_')
                ? tc.parseError
                : `Tool argument JSON parse error for "${tc.name}": ${tc.parseError}. Re-emit valid JSON matching the tool schema.`,
            });
            if (outcomeCheck.action === 'halt') {
              finalAnswer = outcomeCheck.reason ?? 'Stopped after repeated malformed tool JSON.';
              break;
            }
            continue;
          }

          const guard = loopGuard.recordToolAttempt(tc.name, tc.arguments);
          const preLog = preallocatedLogs.get(tc);
          const displayToolName =
            tc.name === '__code_paste_write'
              ? 'create_file'
              : tc.name.startsWith('__code_paste_')
                ? 'patch_file'
                : tc.name;
          const logEntry: ToolCallLog = preLog ?? {
            id: randomUUID(),
            toolName: displayToolName,
            summary: summarizeToolArgs(tc.name, tc.arguments),
            argsPreview: JSON.stringify(tc.arguments).slice(0, 140),
            status: 'running',
            filePath:
              typeof tc.arguments.filePath === 'string'
                ? tc.arguments.filePath
                : undefined,
          };
          if (!preLog) {
            toolLogs.push(logEntry);
            this.emit({
              type: 'tool_update',
              threadId: thread.id,
              turnId: assistantTurn.id,
              tool: logEntry,
            });
          }

          const tTool = Date.now();

          if (guard.action === 'halt') {
            stepHadError = true;
            logEntry.status = 'error';
            logEntry.resultPreview = guard.reason;
            logEntry.durationMs = Date.now() - tTool;
            this.emit({
              type: 'tool_update',
              threadId: thread.id,
              turnId: assistantTurn.id,
              tool: { ...logEntry },
            });
            finalAnswer = `${guard.reason}\n\nPartial progress summary:\n- Modified files: ${ledger.modifiedFiles.join(', ') || 'none'}`;
            break;
          }

          if (guard.action === 'pivot') {
            stepHadError = true;
            logEntry.status = 'error';
            logEntry.resultPreview = guard.reason;
            logEntry.durationMs = Date.now() - tTool;
            this.emit({
              type: 'tool_update',
              threadId: thread.id,
              turnId: assistantTurn.id,
              tool: { ...logEntry },
            });
            stepItem.toolCalls.push({
              name: tc.name,
              arguments: tc.arguments,
              result: guard.reason ?? 'Pivot required.',
            });
            continue;
          }

          try {
            const execResult = await this.executeTool({
              thread,
              assistantTurnId: assistantTurn.id,
              projectRoot: params.projectRoot,
              workdir,
              index,
              mcpServers,
              toolName: tc.name,
              args: tc.arguments,
              ledger,
              loopGuard,
              logEntry,
              signal: ac.signal,
            });

            if (execResult.isError || execResult.denied) stepHadError = true;
            if (tc.name === '__code_paste_write' && !execResult.isError && !execResult.denied) {
              logEntry.toolName = execResult.output.startsWith('Wrote ') ? 'patch_file' : 'create_file';
            }
            logEntry.status = execResult.denied ? 'denied' : execResult.isError ? 'error' : 'ok';
            logEntry.durationMs = Date.now() - tTool;
            logEntry.resultPreview = execResult.output.slice(0, 200);
            logEntry.filePath = execResult.filePath;
            logEntry.linesAdded = execResult.linesAdded;
            logEntry.linesRemoved = execResult.linesRemoved;

            tokensSavedByAst += execResult.tokensSavedByAst ?? 0;
            tokensSavedByHashline += execResult.tokensSavedByHashline ?? 0;

            this.emit({
              type: 'tool_update',
              threadId: thread.id,
              turnId: assistantTurn.id,
              tool: { ...logEntry },
            });

            const outcomeCheck = loopGuard.recordOutcome(
              `${tc.name}:${execResult.filePath ?? ''}`,
              Boolean(execResult.isError),
              execResult.output,
            );
            if (outcomeCheck.action === 'halt') {
              finalAnswer = outcomeCheck.reason ?? 'Stopped after repeated errors.';
              break;
            }

            if (tc.name === 'finish_turn') {
              finishRequested = {
                summary: String(tc.arguments.summary ?? 'Completed.'),
              };
            }

            stepItem.toolCalls.push({
              name: tc.name,
              arguments: tc.arguments,
              result: execResult.output,
              isReadOnlySlice: execResult.isReadOnlySlice,
              isCommandOutput: execResult.isCommandOutput,
              exitCode: execResult.exitCode,
            });
          } catch (error) {
            stepHadError = true;
            const errMsg = error instanceof Error ? error.message : String(error);
            logEntry.status = 'error';
            logEntry.durationMs = Date.now() - tTool;
            logEntry.resultPreview = errMsg.slice(0, 200);
            ledger.activeErrors = [errMsg.slice(0, 400)];
            this.emit({
              type: 'tool_update',
              threadId: thread.id,
              turnId: assistantTurn.id,
              tool: { ...logEntry },
            });
            const outcomeCheck = loopGuard.recordOutcome(
              `${tc.name}:${typeof tc.arguments.filePath === 'string' ? tc.arguments.filePath : ''}`,
              true,
              errMsg,
            );
            stepItem.toolCalls.push({
              name: tc.name,
              arguments: tc.arguments,
              result: `Tool error: ${errMsg}`,
            });
            if (outcomeCheck.action === 'halt') {
              finalAnswer = outcomeCheck.reason ?? 'Stopped after repeated errors.';
              break;
            }
          }
        }

        steps.push(stepItem);

        if (finalAnswer) break;

        if (finishRequested && !stepHadError) {
          const currentEpoch = loopGuard.getMutationEpoch();
          if (
            ledger.modifiedFiles.length > 0 &&
            lastVerifiedEpoch !== currentEpoch &&
            profile.verifyDepth !== 'syntax'
          ) {
            lastVerifiedEpoch = currentEpoch;
            const verifyRes = await this.runAndRecordStageB({
              thread,
              workdir,
              assistantTurnId: assistantTurn.id,
              depth: profile.verifyDepth,
              timeoutMs: profile.verifyTimeoutMs,
              modifiedFiles: ledger.modifiedFiles,
              ledger,
              loopGuard,
              toolLogs,
              steps,
              assistantContent: finishRequested.summary,
              signal: ac.signal,
              onVerifyTime: (ms) => {
                verifyMs += ms;
              },
            });
            if (!verifyRes.passed) {
              if (verifyRes.haltReason) {
                finalAnswer = verifyRes.haltReason;
                break;
              }
              continue;
            }
          }
          if (activePlanEntry) {
            this.completeActivePlanSteps(thread.id);
          }
          finalAnswer = finishRequested.summary;
          break;
        }
      }

      const thinkMs = Date.now() - tThink;

      if (!finalAnswer) {
        finalAnswer = ac.signal.aborted
          ? 'Turn stopped by user.'
          : stepCount >= MAX_TURN_STEPS
            ? `Reached maximum turn step limit (${MAX_TURN_STEPS}). Modified: ${ledger.modifiedFiles.join(', ') || 'none'}.`
            : `Completed ${stepCount} steps. Modified: ${ledger.modifiedFiles.join(', ') || 'none'}.`;
      }

      // ================================================================
      // STAGE 4: Post-Turn Fast Wrap (Thread Title + Telemetry)
      // ================================================================
      let threadTitle: string | undefined;
      if (thread.title === 'New thread') {
        if (!useDistinctFastModel) {
          // Single-model setup: derive heuristic title locally to avoid evicting Main's KV cache
          threadTitle = buildHeuristicThreadTitle(params.userPrompt);
        } else {
          threadTitle = await this.generateThreadTitle(
            resolvedFastModel,
            resolvedMainModel,
            thread.effort,
            params.userPrompt,
            settings,
            fastModelInfo,
          );
        }
        this.store.updateThread(thread.id, { title: threadTitle });
      }

      const evalPerSec =
        totalEvalMs > 0 ? Number(((totalEvalTokens / totalEvalMs) * 1000).toFixed(1)) : 0;
      const effectivePrefixReused = (kvPrefixReused || stepCount > 1) && !anyColdReload;
      const kvCacheHitRate = effectivePrefixReused
        ? Math.min(0.98, Number((zoneA.prefixTokens / Math.max(1, activeContextTokens)).toFixed(2)))
        : 0;

      const telemetry: TelemetrySnapshot = {
        kvCacheHitRate,
        kvPrefixReused,
        kvPrefixTokens: zoneA.prefixTokens,
        promptEvalTokens: totalPromptEvalTokens,
        promptEvalMs: totalPromptEvalMs,
        evalTokens: totalEvalTokens,
        evalTokensPerSec: evalPerSec,
        tokensSavedByAst,
        tokensSavedByHashline,
        tokensSavedByFolding,
        activeContextTokens: activeContextTokens || estimateTokens(zoneA.systemPrompt),
        contextBudget: mainOpts.options.num_ctx,
        stageTimingsMs: {
          prefetch: prefetchMs,
          scout: scoutMs,
          think: thinkMs,
          verify: verifyMs,
        },
        fastModelUsed: resolvedFastModel,
        mainModelUsed: resolvedMainModel,
      };

      const persistedTurn = this.store.listTurns(thread.id).find((t) => t.id === assistantTurn.id);
      const completedTurn: TurnRecord = {
        ...assistantTurn,
        ...(persistedTurn?.plan ? { plan: persistedTurn.plan } : {}),
        ...(persistedTurn?.questionPrompt ? { questionPrompt: persistedTurn.questionPrompt } : {}),
        ...(persistedTurn?.generatedImages ? { generatedImages: persistedTurn.generatedImages } : {}),
        content: finalAnswer,
        thinking: fullThinking || undefined,
        toolCalls: toolLogs,
        ledger,
        telemetry,
      };

      this.store.updateTurn(assistantTurn.id, completedTurn);
      this.store.updateThread(thread.id, { status: 'idle', unread: true });
      this.emit({
        type: 'turn_completed',
        threadId: thread.id,
        turn: completedTurn,
        threadTitle,
      });

      // Drain next queued follow-up prompt if any remain and run was not aborted
      if (!ac.signal.aborted) {
        const latestThread = this.store.getThread(thread.id);
        const queue = latestThread?.queuedPrompts ?? [];
        if (queue.length > 0) {
          const [nextItem, ...rest] = queue;
          const drained = this.store.updateThread(thread.id, { queuedPrompts: rest });
          this.emit({ type: 'thread_updated', thread: drained });
          setImmediate(() => {
            void this.runUserTurn({
              threadId: thread.id,
              content: nextItem.content,
              chips: nextItem.chips,
            });
          });
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isAbort = ac.signal.aborted || /abort/i.test(msg);
      const finalMsg = isAbort ? 'Turn stopped by user.' : `Error: ${msg}`;
      this.store.updateTurn(assistantTurn.id, {
        content: finalMsg,
        toolCalls: toolLogs,
        ledger,
      });
      this.store.updateThread(thread.id, {
        status: isAbort ? 'idle' : 'error',
      });
      this.emit({
        type: 'turn_error',
        threadId: thread.id,
        turnId: assistantTurn.id,
        message: finalMsg,
      });
    } finally {
      this.activeControllers.delete(thread.id);
      this.steeringQueues.delete(thread.id);
    }
  }

  private findLatestApprovedPlan(
    threadId: string,
  ): { turnId: string; plan: StructuredPlan } | null {
    const turns = this.store.listTurns(threadId);
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.plan?.approved) {
        return { turnId: t.id, plan: t.plan };
      }
    }
    return null;
  }

  private updatePlanStepStatus(
    threadId: string,
    turnId: string,
    stepId: string,
    status: 'pending' | 'in_progress' | 'done',
  ): StructuredPlan | null {
    const turns = this.store.listTurns(threadId);
    const target = turns.find((t) => t.id === turnId);
    if (!target?.plan) return null;

    const normTarget = stepId.trim().toLowerCase();
    let matched = false;
    const nextSteps = target.plan.steps.map((s, idx) => {
      const isMatch =
        s.id.toLowerCase() === normTarget ||
        `step-${idx + 1}` === normTarget ||
        String(idx + 1) === normTarget ||
        s.title.toLowerCase() === normTarget;
      if (isMatch) {
        matched = true;
        return { ...s, status };
      }
      return s;
    });

    if (!matched) return null;
    const nextPlan: StructuredPlan = { ...target.plan, steps: nextSteps };
    this.store.updateTurn(turnId, { plan: nextPlan });
    this.emit({ type: 'plan_updated', threadId, turnId, plan: nextPlan });
    return nextPlan;
  }

  private completeActivePlanSteps(threadId: string): void {
    const active = this.findLatestApprovedPlan(threadId);
    if (!active) return;
    const hasUnfinished = active.plan.steps.some((s) => s.status !== 'done');
    if (!hasUnfinished) return;
    const nextPlan: StructuredPlan = {
      ...active.plan,
      steps: active.plan.steps.map((s) => ({ ...s, status: 'done' })),
    };
    this.store.updateTurn(active.turnId, { plan: nextPlan });
    this.emit({ type: 'plan_updated', threadId, turnId: active.turnId, plan: nextPlan });
  }

  private async runAndRecordStageB(params: {
    thread: ThreadRecord;
    workdir: string;
    assistantTurnId: string;
    depth: ReturnType<typeof getEffortProfile>['verifyDepth'];
    timeoutMs: number;
    modifiedFiles: string[];
    ledger: WorkingMemoryLedger;
    loopGuard: LoopGuard;
    toolLogs: ToolCallLog[];
    steps: StepHistoryItem[];
    assistantContent: string;
    signal: AbortSignal;
    onVerifyTime: (ms: number) => void;
  }): Promise<{ passed: boolean; haltReason?: string }> {
    this.setThreadStatus(params.thread.id, 'verifying');
    const t0 = Date.now();
    const logId = randomUUID();
    const verifyLog: ToolCallLog = {
      id: logId,
      toolName: 'verify_gate',
      summary: `Running ${params.depth} checks`,
      argsPreview: params.modifiedFiles.join(', '),
      status: 'running',
    };
    params.toolLogs.push(verifyLog);
    this.emit({
      type: 'tool_update',
      threadId: params.thread.id,
      turnId: params.assistantTurnId,
      tool: verifyLog,
    });

    const results = await runStageBVerification(
      params.workdir,
      params.depth,
      params.modifiedFiles,
      params.signal,
      params.timeoutMs,
    );
    const elapsed = Date.now() - t0;
    params.onVerifyTime(elapsed);

    const failed = results.find((r) => !r.ok);
    verifyLog.durationMs = elapsed;
    verifyLog.status = failed ? 'error' : 'ok';
    verifyLog.resultPreview = failed
      ? `${failed.label} failed`
      : results.map((r) => `${r.label} passed`).join(', ') || 'Syntax verified';
    verifyLog.liveOutput = failed ? failed.digest : undefined;

    this.emit({
      type: 'tool_update',
      threadId: params.thread.id,
      turnId: params.assistantTurnId,
      tool: { ...verifyLog },
    });

    this.setThreadStatus(params.thread.id, 'thinking');

    if (!failed) {
      for (const r of results) {
        params.ledger.verifiedChecks.push(`${r.label} ✓`);
        params.loopGuard.recordOutcome(`verify_gate:${r.label}`, false);
      }
      params.ledger.activeErrors = [];
      return { passed: true };
    }

    const outcomeCheck = params.loopGuard.recordOutcome(
      `verify_gate:${failed.label}`,
      true,
      failed.digest,
    );
    params.ledger.activeErrors = [failed.digest];
    params.steps.push({
      id: randomUUID(),
      assistantContent: params.assistantContent,
      toolCalls: [
        {
          name: 'verify_gate',
          arguments: { check: failed.label },
          result: `Verification failed (${failed.label}). Fix these errors:\n${failed.digest}`,
          isCommandOutput: true,
          exitCode: 1,
        },
      ],
    });
    return {
      passed: false,
      ...(outcomeCheck.action === 'halt' ? { haltReason: outcomeCheck.reason } : {}),
    };
  }

  private async recordDiskMutation(params: {
    workdir: string;
    index: RepoIndex;
    ledger: WorkingMemoryLedger;
    loopGuard: LoopGuard;
    relPath: string;
    absPath: string;
    inside: boolean;
    structural: boolean;
    trackChurn: boolean;
  }): Promise<void> {
    if (params.inside && !params.ledger.modifiedFiles.includes(params.relPath)) {
      params.ledger.modifiedFiles.push(params.relPath);
    }
    params.loopGuard.invalidateOnMutation(params.relPath);
    if (params.trackChurn) {
      params.loopGuard.recordAppliedEdit(params.relPath);
    }
    if (params.inside && existsSync(params.absPath)) {
      this.indexer.markDirty(params.workdir, params.relPath, params.structural);
      const nextText = readFileSync(params.absPath, 'utf8');
      const parsed = await this.treeSitter.extractSymbolsAndImports(params.relPath, nextText);
      params.index.files.set(params.relPath, {
        relPath: params.relPath,
        mtimeMs: Date.now(),
        symbols: parsed.symbols,
        imports: parsed.imports,
        lineCount: nextText.split(/\r?\n/).length,
      });
    }
  }

  private async executeTool(params: {
    thread: ThreadRecord;
    assistantTurnId: string;
    projectRoot: string;
    workdir: string;
    index: RepoIndex;
    mcpServers: McpServerConfig[];
    toolName: string;
    args: Record<string, unknown>;
    ledger: WorkingMemoryLedger;
    loopGuard: LoopGuard;
    logEntry: ToolCallLog;
    signal: AbortSignal;
  }): Promise<{
    output: string;
    isError?: boolean;
    denied?: boolean;
    isReadOnlySlice?: boolean;
    isCommandOutput?: boolean;
    exitCode?: number;
    filePath?: string;
    linesAdded?: number;
    linesRemoved?: number;
    tokensSavedByAst?: number;
    tokensSavedByHashline?: number;
  }> {
    const {
      thread,
      assistantTurnId,
      projectRoot,
      workdir,
      index,
      mcpServers,
      toolName,
      args,
      ledger,
      loopGuard,
      logEntry,
    } = params;

    if (toolName === 'propose_plan') {
      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      const plan: StructuredPlan = {
        id: randomUUID(),
        title: String(args.title ?? 'Implementation Plan'),
        summary: String(args.summary ?? ''),
        steps: rawSteps.map((st, idx) => ({
          id: `step-${idx + 1}`,
          title: typeof st === 'string' ? st : String((st as { title?: string })?.title ?? ''),
          status: 'pending',
        })),
        approved: false,
      };
      this.store.updateTurn(assistantTurnId, { plan });
      this.emit({
        type: 'plan_proposed',
        threadId: thread.id,
        turnId: assistantTurnId,
        plan,
      });
      return {
        output: `Plan "${plan.title}" (${plan.steps.length} steps) published to the user for review. Summarize briefly and call finish_turn.`,
      };
    }

    if (toolName === 'update_plan_step') {
      const stepId = String(args.stepId ?? '');
      const rawStatus = String(args.status ?? 'in_progress');
      const status: 'pending' | 'in_progress' | 'done' =
        rawStatus === 'done' || rawStatus === 'pending' ? rawStatus : 'in_progress';
      const active = this.findLatestApprovedPlan(thread.id);
      if (!active) {
        return { output: 'No active approved plan in this thread.', isError: true };
      }
      const updated = this.updatePlanStepStatus(thread.id, active.turnId, stepId, status);
      if (!updated) {
        return {
          output: `Plan step "${stepId}" not found. Available steps: ${active.plan.steps.map((s) => s.id).join(', ')}`,
          isError: true,
        };
      }
      return {
        output: `Updated ${stepId} -> ${status}.`,
      };
    }

    if (toolName === 'request_user_input') {
      const parseOptions = (raw: unknown): QuestionOption[] =>
        (Array.isArray(raw) ? raw : []).map((opt) =>
          typeof opt === 'string'
            ? { label: opt }
            : {
                label: String((opt as { label?: string }).label ?? 'Option'),
                description: (opt as { description?: string }).description,
              },
        );
      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      const normalizedQuestions: QuestionItem[] =
        rawQuestions.length > 0
          ? rawQuestions.map((q, idx) => {
              const item = (q ?? {}) as {
                id?: unknown;
                question?: unknown;
                options?: unknown;
                allowCustom?: unknown;
                multiSelect?: unknown;
              };
              return {
                id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `q-${idx + 1}`,
                question: String(item.question ?? 'Please clarify how to proceed:'),
                options: parseOptions(item.options),
                allowCustom: item.allowCustom !== false,
                multiSelect: Boolean(item.multiSelect),
              };
            })
          : [
              {
                id: 'q-1',
                question: String(args.question ?? 'Please clarify how to proceed:'),
                options: parseOptions(args.options),
                allowCustom: args.allowCustom !== false,
                multiSelect: Boolean(args.multiSelect),
              },
            ];
      const primary = normalizedQuestions[0];
      const promptId = randomUUID();
      const questionPrompt: UserQuestionPrompt = {
        id: promptId,
        question: primary.question,
        options: primary.options,
        allowCustom: primary.allowCustom,
        multiSelect: primary.multiSelect,
        questions: normalizedQuestions,
      };
      this.store.updateTurn(assistantTurnId, { questionPrompt });
      const answerPromise = new Promise<{
        answers: string[];
        answersByQuestion?: Record<string, string[]>;
      }>((resolve) => {
        this.pendingQuestions.set(promptId, {
          threadId: thread.id,
          turnId: assistantTurnId,
          resolve,
        });
      });
      this.setThreadStatus(thread.id, 'awaiting_input');
      this.emit({
        type: 'question_requested',
        threadId: thread.id,
        turnId: assistantTurnId,
        prompt: questionPrompt,
      });
      const response = await answerPromise;
      this.setThreadStatus(thread.id, 'thinking');
      if (response.answersByQuestion && normalizedQuestions.length > 1) {
        const formatted = normalizedQuestions
          .map((q, i) => {
            const picked = response.answersByQuestion?.[q.id] ?? [];
            return `- Q${i + 1} (${q.question}): ${picked.join(', ') || '(Skipped)'}`;
          })
          .join('\n');
        return {
          output: `User answered:\n${formatted}`,
        };
      }
      return {
        output: `User answered: ${response.answers.join(', ')}`,
      };
    }

    if (
      thread.interactionMode === 'plan' &&
      (toolName === 'patch_file' ||
        toolName === 'patch_hashline' ||
        toolName === 'create_file' ||
        toolName === 'delete_file' ||
        toolName === 'move_file' ||
        toolName === 'save_skill' ||
        toolName === 'generate_image' ||
        toolName.startsWith('__code_paste_'))
    ) {
      return {
        output:
          'Plan Mode is active (read-only). Do not modify files or skills yet — use propose_plan to present your plan for approval.',
        denied: true,
        isError: true,
      };
    }

    if (toolName === 'read_skill') {
      const skillName = String(args.name ?? '');
      const referencePath = args.referencePath ? String(args.referencePath) : undefined;
      const skills = discoverSkills(projectRoot);
      const detail = readSkillDetail(skills, skillName, referencePath);
      if (detail.found && detail.skill) {
        ledger.inspectedSymbols.push(`skill:${detail.skill.name}`);
      }
      return {
        output: detail.output,
        isError: !detail.found,
        isReadOnlySlice: true,
      };
    }

    if (toolName === 'save_skill') {
      if (thread.approvalPolicy === 'read-only') {
        return {
          output: 'Blocked: thread approval policy is set to read-only.',
          denied: true,
          isError: true,
        };
      }
      const rawScope = String(args.scope ?? 'repo');
      const scope: 'repo' | 'global' = rawScope === 'global' ? 'global' : 'repo';
      const name = String(args.name ?? '');
      const description = String(args.description ?? '');
      const content = String(args.content ?? '');
      const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : undefined;
      const companionFiles = Array.isArray(args.companionFiles)
        ? args.companionFiles
            .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
            .map((f) => ({ path: String(f.path ?? ''), content: String(f.content ?? '') }))
            .filter((f) => f.path)
        : undefined;

      if (!name.trim() || !content.trim()) {
        return { output: 'save_skill requires non-empty name and content.', isError: true };
      }

      if (scope === 'global' && thread.approvalPolicy === 'auto') {
        const decision = await this.requestUserApproval({
          threadId: thread.id,
          kind: 'save_global_skill',
          title: `Save global skill /${name}`,
          commandOrPath: `~/.smolcode/skills/${name}/SKILL.md`,
          cwd: projectRoot,
          reason: 'Global skills write outside the active workspace (~/.smolcode/skills).',
        });
        this.setThreadStatus(thread.id, 'thinking');
        if (decision === 'deny') {
          return {
            output: `User denied saving global skill "${name}".`,
            denied: true,
            isError: true,
          };
        }
      }

      const saved = saveSkillFile({
        projectRoot,
        scope,
        name,
        description,
        content,
        tags,
        companionFiles,
      });
      loopGuard.invalidateOnMutation(saved.sourcePath);
      const updatedSkills = discoverSkills(projectRoot);
      this.emit({
        type: 'skills_updated',
        projectId: thread.projectId,
        skills: updatedSkills,
      });

      const relToRoot =
        scope === 'repo' && saved.sourcePath.startsWith(projectRoot)
          ? saved.sourcePath.slice(projectRoot.length + 1).replace(/\\/g, '/')
          : saved.sourcePath;
      if (scope === 'repo' && !ledger.modifiedFiles.includes(relToRoot)) {
        ledger.modifiedFiles.push(relToRoot);
      }

      return {
        output: `Saved ${scope} skill "/${saved.name}" at ${saved.sourcePath}. Users can invoke it with /${saved.name}.`,
        filePath: scope === 'repo' ? relToRoot : undefined,
        linesAdded: content.split(/\r?\n/).length,
      };
    }

    if (toolName.startsWith('mcp__') && this.mcp) {
      const parts = toolName.split('__');
      const serverSlug = parts[1] ?? '';
      const rawToolSlug = parts.slice(2).join('__');
      const server = mcpServers.find(
        (s) => s.enabled && s.name.replace(/[^a-zA-Z0-9_-]/g, '_') === serverSlug,
      );
      const matchedTool = server?.tools?.find(
        (t) => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === rawToolSlug,
      );
      if (!server || !matchedTool) {
        return { output: `MCP tool not available: ${toolName}`, isError: true };
      }
      if (thread.approvalPolicy === 'read-only') {
        const decision = await this.requestUserApproval({
          threadId: thread.id,
          kind: 'mcp_tool',
          title: `Call MCP tool ${server.name}/${matchedTool.name}`,
          commandOrPath: JSON.stringify(args),
          cwd: workdir,
          reason: `Thread policy is read-only.`,
        });
        this.setThreadStatus(thread.id, 'thinking');
        if (decision === 'deny') {
          return { output: `User denied MCP tool ${matchedTool.name}`, denied: true, isError: true };
        }
      }
      const res = await this.mcp.callTool(server, matchedTool.name, args);
      return { output: res.output, isError: res.isError };
    }

    if (toolName === 'list_dir') {
      const dirPath = String(args.dirPath ?? '.');
      const maxDepth = args.maxDepth !== undefined ? Number(args.maxDepth) : 2;
      return {
        output: runListDir(workdir, dirPath, maxDepth),
        isReadOnlySlice: true,
      };
    }

    if (toolName === 'find_files') {
      const pattern = String(args.pattern ?? '*');
      const pathPrefix = args.pathPrefix ? String(args.pathPrefix) : undefined;
      return {
        output: runFindFiles(workdir, pattern, pathPrefix),
        isReadOnlySlice: true,
      };
    }

    if (toolName === 'web_lookup') {
      const settings = this.store.getSettings();
      if (settings.webLookupEnabled === false) {
        return {
          output: 'Web lookup is disabled in Settings -> General.',
          denied: true,
          isError: true,
        };
      }
      const res = await runObscuraLookup({
        url: args.url ? String(args.url) : undefined,
        query: args.query ? String(args.query) : undefined,
        obscuraPath: settings.obscuraPath,
        signal: params.signal,
      });
      return {
        output: res.output,
        isError: res.isError,
        isReadOnlySlice: true,
      };
    }

    if (toolName === 'generate_image') {
      const settings = this.store.getSettings();
      const saveToRelPath = args.saveToRelPath ? String(args.saveToRelPath).trim() : '';
      if (saveToRelPath && thread.approvalPolicy === 'read-only') {
        return {
          output: 'Blocked: thread approval policy is read-only; cannot write generated image into workspace.',
          denied: true,
          isError: true,
        };
      }
      if (saveToRelPath) {
        const resolvedTarget = resolveInsideWorkdir(workdir, saveToRelPath);
        if (!resolvedTarget.inside) {
          return {
            output: `Refusing to save generated image outside workspace: ${saveToRelPath}`,
            denied: true,
            isError: true,
          };
        }
      }

      const result = await runLocalImageGeneration({
        threadId: thread.id,
        turnId: assistantTurnId,
        prompt: String(args.prompt ?? ''),
        negativePrompt: args.negativePrompt ? String(args.negativePrompt) : undefined,
        size: args.size ? String(args.size) : settings.imageGenDefaultSize,
        steps: args.steps !== undefined ? Number(args.steps) : undefined,
        seed: args.seed !== undefined ? Number(args.seed) : undefined,
        settings,
        signal: params.signal,
        beforeGenerate: async (backend, targetModel) => {
          const running = await this.ollama.listRunningModels();
          for (const loaded of running) {
            if (backend === 'ollama' && loaded.name === targetModel) continue;
            await this.ollama.unloadModel(loaded.name);
          }
        },
      });

      if (!result.ok || !result.image) {
        return {
          output: result.error || 'Local image generation failed.',
          isError: true,
        };
      }

      const currentTurn = this.store
        .listTurns(thread.id)
        .find((t) => t.id === assistantTurnId);
      const nextImages = [...(currentTurn?.generatedImages ?? []), result.image];
      this.store.updateTurn(assistantTurnId, { generatedImages: nextImages });
      this.emit({
        type: 'image_generated',
        threadId: thread.id,
        turnId: assistantTurnId,
        image: result.image,
      });

      let savedRel: string | undefined;
      if (saveToRelPath) {
        const resolvedTarget = resolveInsideWorkdir(workdir, saveToRelPath);
        if (resolvedTarget.inside) {
          mkdirSync(dirname(resolvedTarget.absPath), { recursive: true });
          copyFileSync(result.image.filePath, resolvedTarget.absPath);
          savedRel = resolvedTarget.relPath;
          loopGuard.invalidateOnMutation(resolvedTarget.relPath);
          this.indexer.markDirty(workdir, resolvedTarget.relPath, false);
          if (!ledger.modifiedFiles.includes(resolvedTarget.relPath)) {
            ledger.modifiedFiles.push(resolvedTarget.relPath);
          }
        }
      }

      return {
        output: [
          `Generated ${result.image.width}x${result.image.height} image via ${result.image.backend} (${result.image.model}) in ${(result.image.durationMs / 1000).toFixed(1)}s.`,
          `Seed: ${result.image.seed}, Steps: ${result.image.steps}.`,
          savedRel ? `Saved to workspace: ${savedRel}.` : 'Rendered inline in thread.',
        ].join(' '),
        filePath: savedRel,
      };
    }

    if (toolName === 'repo_search') {
      const query = String(args.query ?? '');
      const pathPrefix = args.pathPrefix ? String(args.pathPrefix) : undefined;
      return {
        output: runRepoSearch(index, query, pathPrefix, 30, (relPath) =>
          this.indexer.getCachedFileLines(workdir, relPath),
        ),
        isReadOnlySlice: true,
      };
    }

    if (toolName === 'read_symbol') {
      const filePath = String(args.filePath ?? '');
      const symbolName = String(args.symbolName ?? '');
      const res = runReadSymbol(index, this.indexer, filePath, symbolName);
      ledger.inspectedSymbols.push(`${filePath}::${symbolName}`);
      loopGuard.recordReadRefresh(filePath);
      return {
        output: res.output,
        isReadOnlySlice: true,
        filePath,
        tokensSavedByAst: res.tokensSavedApprox,
      };
    }

    if (toolName === 'read_range') {
      const filePath = String(args.filePath ?? '');
      const startLine = Number(args.startLine ?? 1);
      const endLine = Number(args.endLine ?? startLine + 60);
      const res = runReadRange(workdir, filePath, startLine, endLine);
      ledger.inspectedSymbols.push(`${filePath}:L${startLine}-${endLine}`);
      loopGuard.recordReadRefresh(filePath);
      return {
        output: res.output,
        isReadOnlySlice: true,
        filePath,
        tokensSavedByAst: res.tokensSavedApprox,
      };
    }

    if (toolName === '__code_paste_write') {
      const filePath = String(args.filePath ?? '');
      const gate = await this.ensureFileWriteAllowed({
        thread,
        workdir,
        toolName: 'create_file',
        targetPaths: [filePath],
      });
      if (!gate.allowed) {
        return { output: gate.deniedOutput, denied: true, isError: true };
      }
      const res = await runWriteFilePaste({
        workdir,
        filePath,
        content: String(args.content ?? ''),
        treeSitter: this.treeSitter,
        readOnly: thread.approvalPolicy === 'read-only',
        allowOutsideRoot: gate.allowOutsideRoot,
      });
      ledger.activeErrors = res.syntaxOk ? [] : [res.output];
      if (res.ok) {
        await this.recordDiskMutation({
          workdir,
          index,
          ledger,
          loopGuard,
          relPath: res.relPath,
          absPath: res.absPath,
          inside: res.inside,
          structural: !res.existed,
          trackChurn: true,
        });
      }
      return {
        output: res.output,
        isError: !res.syntaxOk,
        filePath: res.relPath,
        linesAdded: res.linesAdded,
        linesRemoved: res.linesRemoved,
      };
    }

    if (toolName === '__code_paste_symbol' || toolName === '__code_paste_range') {
      const filePath = String(args.filePath ?? '');
      const gate = await this.ensureFileWriteAllowed({
        thread,
        workdir,
        toolName: 'patch_file',
        targetPaths: [filePath],
      });
      if (!gate.allowed) {
        return { output: gate.deniedOutput, denied: true, isError: true };
      }
      const res =
        toolName === '__code_paste_symbol'
          ? await runReplaceSymbolPaste({
              workdir,
              index,
              indexer: this.indexer,
              filePath,
              symbolName: String(args.symbolName ?? ''),
              content: String(args.content ?? ''),
              treeSitter: this.treeSitter,
              readOnly: thread.approvalPolicy === 'read-only',
              allowOutsideRoot: gate.allowOutsideRoot,
            })
          : await runReplaceLineRange({
              workdir,
              filePath,
              startLine: Number(args.startLine ?? 1),
              endLine: Number(args.endLine ?? args.startLine ?? 1),
              content: String(args.content ?? ''),
              treeSitter: this.treeSitter,
              readOnly: thread.approvalPolicy === 'read-only',
              allowOutsideRoot: gate.allowOutsideRoot,
            });
      ledger.activeErrors = res.syntaxOk ? [] : [res.output];
      if (res.ok) {
        await this.recordDiskMutation({
          workdir,
          index,
          ledger,
          loopGuard,
          relPath: res.relPath,
          absPath: res.absPath,
          inside: res.inside,
          structural: false,
          trackChurn: true,
        });
      }
      return {
        output: res.output,
        isError: !res.syntaxOk,
        filePath: res.relPath,
        linesAdded: res.linesAdded,
        linesRemoved: res.linesRemoved,
      };
    }

    if (toolName === 'patch_file' || toolName === 'patch_hashline') {
      const filePath = String(args.filePath ?? '');
      const gate = await this.ensureFileWriteAllowed({
        thread,
        workdir,
        toolName,
        targetPaths: [filePath],
      });
      if (!gate.allowed) {
        return { output: gate.deniedOutput, denied: true, isError: true };
      }
      let oldText = args.oldText !== undefined ? String(args.oldText) : undefined;
      let newText = args.newText !== undefined ? String(args.newText) : undefined;
      const rawEdits = Array.isArray(args.edits) ? args.edits : undefined;
      if (
        oldText === undefined &&
        newText === undefined &&
        rawEdits &&
        rawEdits.length === 1 &&
        rawEdits[0] &&
        typeof rawEdits[0] === 'object'
      ) {
        const first = rawEdits[0] as Record<string, unknown>;
        const rawOld = first.oldText ?? first.old_text ?? first.old ?? first.search;
        const rawNew = first.newText ?? first.new_text ?? first.new ?? first.replace;
        if (rawOld !== undefined && rawNew !== undefined) {
          oldText = String(rawOld);
          newText = String(rawNew);
        }
      }
      const edits = rawEdits ? normalizeHashlineEdits(rawEdits) : undefined;
      const res = await runPatchFile({
        workdir,
        filePath,
        oldText,
        newText,
        edits,
        treeSitter: this.treeSitter,
        readOnly: thread.approvalPolicy === 'read-only',
        allowOutsideRoot: gate.allowOutsideRoot,
      });
      ledger.activeErrors = res.syntaxOk ? [] : [res.output];
      if (res.ok) {
        await this.recordDiskMutation({
          workdir,
          index,
          ledger,
          loopGuard,
          relPath: res.relPath,
          absPath: res.absPath,
          inside: res.inside,
          structural: false,
          trackChurn: true,
        });
      }
      return {
        output: res.output,
        isError: !res.syntaxOk,
        filePath: res.relPath,
        linesAdded: res.linesAdded,
        linesRemoved: res.linesRemoved,
        tokensSavedByHashline: res.tokensSavedByHashline,
      };
    }

    if (toolName === 'create_file') {
      const filePath = String(args.filePath ?? '');
      const gate = await this.ensureFileWriteAllowed({
        thread,
        workdir,
        toolName,
        targetPaths: [filePath],
      });
      if (!gate.allowed) {
        return { output: gate.deniedOutput, denied: true, isError: true };
      }
      const content = String(args.content ?? '');
      const res = await runCreateFile({
        workdir,
        filePath,
        content,
        treeSitter: this.treeSitter,
        readOnly: thread.approvalPolicy === 'read-only',
        allowOutsideRoot: gate.allowOutsideRoot,
      });
      ledger.activeErrors = res.syntaxOk ? [] : [res.output];
      if (res.ok) {
        await this.recordDiskMutation({
          workdir,
          index,
          ledger,
          loopGuard,
          relPath: res.relPath,
          absPath: res.absPath,
          inside: res.inside,
          structural: true,
          trackChurn: false,
        });
      }
      return {
        output: res.output,
        isError: !res.syntaxOk,
        filePath: res.relPath,
        linesAdded: res.linesAdded,
      };
    }

    if (toolName === 'delete_file') {
      const filePath = String(args.filePath ?? '');
      const gate = await this.ensureFileWriteAllowed({
        thread,
        workdir,
        toolName,
        targetPaths: [filePath],
      });
      if (!gate.allowed) {
        return { output: gate.deniedOutput, denied: true, isError: true };
      }
      const res = runDeleteFile({
        workdir,
        filePath,
        readOnly: thread.approvalPolicy === 'read-only',
        allowOutsideRoot: gate.allowOutsideRoot,
      });
      if (res.inside && !ledger.modifiedFiles.includes(res.relPath)) {
        ledger.modifiedFiles.push(res.relPath);
      }
      loopGuard.invalidateOnMutation(res.relPath);
      if (res.inside) {
        this.indexer.markDirty(workdir, res.relPath, true);
        index.files.delete(res.relPath);
      }
      return {
        output: res.output,
        filePath: res.relPath,
        linesRemoved: res.linesRemoved,
      };
    }

    if (toolName === 'move_file') {
      const fromPath = String(args.fromPath ?? '');
      const toPath = String(args.toPath ?? '');
      const gate = await this.ensureFileWriteAllowed({
        thread,
        workdir,
        toolName,
        targetPaths: [fromPath, toPath],
      });
      if (!gate.allowed) {
        return { output: gate.deniedOutput, denied: true, isError: true };
      }
      const overwrite = Boolean(args.overwrite);
      const res = runMoveFile({
        workdir,
        fromPath,
        toPath,
        readOnly: thread.approvalPolicy === 'read-only',
        overwrite,
        allowOutsideRoot: gate.allowOutsideRoot,
      });
      if (res.toInside && !ledger.modifiedFiles.includes(res.toRel)) {
        ledger.modifiedFiles.push(res.toRel);
      }
      loopGuard.invalidateOnMutation(res.toRel);
      const movedEntry = res.fromInside ? index.files.get(res.fromRel) : undefined;
      if (res.fromInside) {
        this.indexer.markDirty(workdir, res.fromRel, true);
        index.files.delete(res.fromRel);
      }
      if (res.toInside) {
        this.indexer.markDirty(workdir, res.toRel, true);
        if (movedEntry) {
          index.files.set(res.toRel, { ...movedEntry, relPath: res.toRel, mtimeMs: Date.now() });
        }
      }
      return {
        output: res.output,
        filePath: res.toRel,
      };
    }

    if (toolName === 'run_command') {
      const command = String(args.command ?? '');
      if (thread.interactionMode === 'plan') {
        const gatePlan = commandNeedsApproval(command, 'read-only', new Set());
        if (gatePlan === 'deny') {
          return {
            output: `Plan Mode allows read-only commands only. Blocked: ${command}`,
            denied: true,
            isError: true,
          };
        }
      }
      let sessionSet = this.sessionApprovedCmds.get(thread.id);
      if (!sessionSet) {
        sessionSet = new Set<string>();
        this.sessionApprovedCmds.set(thread.id, sessionSet);
      }
      const gate = commandNeedsApproval(command, thread.approvalPolicy, sessionSet);

      if (gate === 'deny') {
        return {
          output: `Command blocked by read-only approval policy: ${command}`,
          denied: true,
          isError: true,
        };
      }

      if (gate === 'ask') {
        const decision = await this.requestUserApproval({
          threadId: thread.id,
          kind: 'command',
          title: 'Run shell command',
          commandOrPath: command,
          cwd: workdir,
          reason: `Thread approval policy is "${thread.approvalPolicy}".`,
        });
        this.setThreadStatus(thread.id, 'thinking');
        if (decision === 'deny') {
          return {
            output: `User denied command execution: ${command}`,
            denied: true,
            isError: true,
          };
        }
        if (decision === 'allow-session') {
          sessionSet.add(command.trim());
        }
      }

      const cmdRes = await executeSandboxedCommand({
        command,
        cwd: workdir,
        signal: params.signal,
        onOutputChunk: (liveText) => {
          logEntry.liveOutput = liveText;
          this.emit({
            type: 'tool_update',
            threadId: thread.id,
            turnId: assistantTurnId,
            tool: { ...logEntry },
          });
        },
      });
      logEntry.liveOutput = cmdRes.output;
      if (cmdRes.exitCode === 0) {
        ledger.verifiedChecks.push(command.slice(0, 48));
      } else {
        ledger.activeErrors = [cmdRes.output.slice(0, 400)];
      }
      return {
        output: cmdRes.output,
        isError: cmdRes.exitCode !== 0,
        isCommandOutput: true,
        exitCode: cmdRes.exitCode,
      };
    }

    if (toolName === 'finish_turn') {
      return { output: String(args.summary ?? 'Done.') };
    }

    return { output: `Unknown tool: ${toolName}`, isError: true };
  }

  private async generateThreadTitle(
    fastModel: string,
    mainModel: string,
    effort: ThreadRecord['effort'],
    prompt: string,
    settings: ReturnType<SmolCodeStore['getSettings']>,
    fastModelInfo?: OllamaModelInfo,
  ): Promise<string> {
    const fallback = prompt.trim().replace(/\s+/g, ' ').slice(0, 44) || 'New thread';
    if (!fastModel && !mainModel) return fallback;
    try {
      const opts = this.scheduler.resolveRoleOptions({
        role: 'fast',
        fastModel: fastModel || mainModel,
        mainModel: mainModel || fastModel,
        effort,
        settings,
        modelInfo: fastModelInfo,
      });
      const resp = await this.ollama.chatStream({
        model: opts.model,
        think: opts.think,
        keep_alive: opts.keepAlive,
        options: opts.options,
        messages: [
          {
            role: 'system',
            content:
              'Output ONLY a 3 to 6 word title for this coding task. No quotes, no markdown, no punctuation.',
          },
          { role: 'user', content: prompt.slice(0, 300) },
        ],
      });
      const cleaned = resp.content.trim().replace(/^["'`]|["'`]$/g, '').slice(0, 56);
      return cleaned || fallback;
    } catch {
      return fallback;
    }
  }
}
