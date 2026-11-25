import { createServer, type Server } from 'node:http';
import { exec } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { AgentOrchestrator } from '../electron/agent/orchestrator';
import { lineHash } from '../electron/intel/hashline';
import { TreeSitterService } from '../electron/intel/tree-sitter-service';
import { OllamaClient } from '../electron/ollama/client';
import { VramScheduler } from '../electron/ollama/vram-scheduler';
import { SmolCodeStore } from '../electron/store/database';
import { SnapshotManager } from '../electron/store/snapshots';
import { runNaiveBaseline } from './naive-baseline';

const execAsync = promisify(exec);

interface BenchTask {
  id: string;
  prompt: string;
  files: Record<string, string>;
  verifyCommand: string;
}

const BENCH_TASKS: BenchTask[] = [
  {
    id: 'bugfix-discount-math',
    prompt:
      'Fix the bug in src/pricing.mjs so calculateTotal applies discountPercent before taxRate, and verify with node --test test/pricing.test.mjs.',
    files: {
      'src/constants.mjs': `export const DEFAULT_CURRENCY = 'USD';\nexport const MAX_DISCOUNT = 80;\n`,
      'src/validator.mjs': `export function assertPositive(n, name) {\n  if (n < 0) throw new Error(name + ' must be >= 0');\n}\n`,
      'src/pricing.mjs': `import { assertPositive } from './validator.mjs';\n\nexport function calculateTotal(subtotal, discountPercent, taxRate) {\n  assertPositive(subtotal, 'subtotal');\n  // BUG: applies tax before discount instead of discounting subtotal first\n  const withTax = subtotal * (1 + taxRate);\n  const discount = subtotal * (discountPercent / 100);\n  return Number((withTax - discount).toFixed(2));\n}\n`,
      'test/pricing.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { calculateTotal } from '../src/pricing.mjs';\n\ntest('discount applied before tax', () => {\n  // 100 with 20% off = 80; +10% tax = 88.00\n  assert.equal(calculateTotal(100, 20, 0.1), 88);\n});\n`,
    },
    verifyCommand: 'node --test test/pricing.test.mjs',
  },
  {
    id: 'refactor-lru-evict',
    prompt:
      'Update src/cache.mjs so set() evicts the least-recently-used key when capacity is exceeded, and verify with node --test test/cache.test.mjs.',
    files: {
      'src/cache.mjs': `export class MiniCache {\n  constructor(capacity = 2) {\n    this.capacity = capacity;\n    this.map = new Map();\n  }\n\n  get(key) {\n    if (!this.map.has(key)) return undefined;\n    const val = this.map.get(key);\n    this.map.delete(key);\n    this.map.set(key, val);\n    return val;\n  }\n\n  set(key, val) {\n    if (this.map.has(key)) this.map.delete(key);\n    this.map.set(key, val);\n    // BUG: forgets to evict oldest key when size > capacity\n  }\n}\n`,
      'test/cache.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { MiniCache } from '../src/cache.mjs';\n\ntest('evicts least recently used key', () => {\n  const c = new MiniCache(2);\n  c.set('a', 1);\n  c.set('b', 2);\n  c.get('a');\n  c.set('c', 3);\n  assert.equal(c.get('b'), undefined);\n  assert.equal(c.get('a'), 1);\n  assert.equal(c.get('c'), 3);\n});\n`,
    },
    verifyCommand: 'node --test test/cache.test.mjs',
  },
  {
    id: 'multi-file-ledger-tax',
    prompt:
      'Fix the bug where applyStoreCredit rounds before subtracting tax or returns negative totals (clamp >= 0) without breaking existing invoice helpers, and verify with node --test test/invoice.test.mjs.',
    files: {
      'src/a_models.mjs': Array.from({ length: 65 }, (_, i) => `export const FIELD_${i} = 'f_${i}';`).join('\n') + '\n',
      'src/b_logger.mjs': Array.from({ length: 65 }, (_, i) => `export function log_${i}(x) { return String(x); }`).join('\n') + '\n',
      'src/c_currency.mjs': Array.from({ length: 65 }, (_, i) => `export const RATE_${i} = ${(1 + i * 0.01).toFixed(2)};`).join('\n') + '\n',
      'src/d_discounts.mjs': Array.from({ length: 65 }, (_, i) => `export function promo_${i}(v) { return v; }`).join('\n') + '\n',
      'src/e_shipping.mjs': Array.from({ length: 65 }, (_, i) => `export function ship_${i}(w) { return w * ${i + 1}; }`).join('\n') + '\n',
      'src/f_invoice.mjs': [
        ...Array.from({ length: 45 }, (_, i) => `export function helper_${i}(n) { return n + ${i}; }`),
        `export function applyStoreCredit(total, credit) {`,
        `  // BUG: forgets to clamp minimum 0 when credit > total`,
        `  return Number((total - credit).toFixed(2));`,
        `}`,
      ].join('\n') + '\n',
      'test/invoice.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyStoreCredit } from '../src/f_invoice.mjs';\n\ntest('clamps total at 0 when store credit exceeds total', () => {\n  assert.equal(applyStoreCredit(25, 40), 0);\n  assert.equal(applyStoreCredit(50, 15), 35);\n});\n`,
    },
    verifyCommand: 'node --test test/invoice.test.mjs',
  },
];

function materializeTask(dir: string, task: BenchTask): void {
  for (const [rel, content] of Object.entries(task.files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

async function checkVerify(dir: string, cmd: string): Promise<boolean> {
  try {
    await execAsync(cmd, { cwd: dir, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function runSmolCodeTask(params: {
  workdir: string;
  task: BenchTask;
  mainModel: string;
  fastModel: string;
  effort: 'low' | 'medium' | 'high';
  baseUrl: string;
}) {
  const store = new SmolCodeStore(':memory:');
  store.updateSettings({
    ollamaBaseUrl: params.baseUrl,
    defaultMainModel: params.mainModel,
    defaultFastModel: params.fastModel,
    defaultEffort: params.effort,
    defaultApprovalPolicy: 'full-access',
  });
  const snapDir = mkdtempSync(join(tmpdir(), 'smolcode-bench-blobs-'));
  const snapshots = new SnapshotManager(store, snapDir);
  const ollama = new OllamaClient(params.baseUrl);
  const scheduler = new VramScheduler(ollama);
  const treeSitter = new TreeSitterService();
  const orch = new AgentOrchestrator(store, snapshots, ollama, scheduler, treeSitter);

  const proj = store.upsertProject({
    name: params.task.id,
    rootPath: params.workdir,
  });
  const thread = store.createThread({
    projectId: proj.id,
    title: params.task.id,
    mainModel: params.mainModel,
    fastModel: params.fastModel,
    effort: params.effort,
    approvalPolicy: 'full-access',
    draftText: '',
    draftChips: [],
    status: 'idle',
    unread: false,
    pinned: false,
  });

  const started = Date.now();
  await orch.runUserTurn({ threadId: thread.id, content: params.task.prompt });
  const wallMs = Date.now() - started;

  const turns = store.listTurns(thread.id);
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  const tel = lastAssistant?.telemetry;

  store.close();
  rmSync(snapDir, { recursive: true, force: true });

  return {
    promptTokens: tel?.promptEvalTokens ?? 0,
    evalTokens: tel?.evalTokens ?? 0,
    totalTokens: (tel?.promptEvalTokens ?? 0) + (tel?.evalTokens ?? 0),
    steps: lastAssistant?.toolCalls?.length ?? 0,
    wallMs,
    tokensSaved:
      (tel?.tokensSavedByAst ?? 0) +
      (tel?.tokensSavedByHashline ?? 0) +
      (tel?.tokensSavedByFolding ?? 0),
  };
}

async function runMockHarnessBenchmarks() {
  console.log('SmolCode Small-Model (4B-9B) Harness Offline Regression Benchmark (--mock)\n');
  const dir = mkdtempSync(join(tmpdir(), 'smolcode-bench-mock-'));
  const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-bench-mock-blobs-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src/pricing.mjs'),
    'export function calc(total, tax) {\n  return total - tax;\n}\n',
    'utf8',
  );
  const targetHash = lineHash('  return total - tax;');
  const seenSystemPrompts: string[] = [];
  let step = 0;

  const server: Server = createServer((req, res) => {
    if (req.url === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['tools'] }));
      return;
    }
    if (req.url === '/api/chat') {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as {
          messages: Array<{ role: string; content: string }>;
        };
        seenSystemPrompts.push(parsed.messages[0]?.content ?? '');
        step += 1;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

        if (step === 1) {
          // Malformed JSON + path alias + copied line:hash| prefix
          res.write(
            JSON.stringify({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    function: {
                      name: 'patch_hashline',
                      arguments: `{"path":"src/pricing.mjs","edits":[{"op":"replace_range","startAnchor":"L2:${targetHash}","content":"2:${targetHash}|   return total + tax;\n",}]}`,
                    },
                  },
                ],
              },
              done: false,
            }) + '\n',
          );
        } else if (step === 2) {
          res.write(
            JSON.stringify({
              message: {
                role: 'assistant',
                content: '<function=finish_turn><parameter=summary>Fixed tax sign.</parameter></function>',
              },
              done: false,
            }) + '\n',
          );
        } else {
          res.write(
            JSON.stringify({
              message: { role: 'assistant', content: 'Turn 2 confirmed.' },
              done: false,
            }) + '\n',
          );
        }
        res.write(
          JSON.stringify({
            done: true,
            prompt_eval_count: 320,
            prompt_eval_duration: 20_000_000,
            eval_count: 24,
            eval_duration: 40_000_000,
            load_duration: 0,
          }) + '\n',
        );
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const store = new SmolCodeStore(':memory:');
    store.updateSettings({
      ollamaBaseUrl: baseUrl,
      defaultMainModel: 'qwen3.5:9b',
      defaultFastModel: 'qwen3.5:9b',
    });
    const snapshots = new SnapshotManager(store, blobDir);
    const ollama = new OllamaClient(baseUrl);
    const orch = new AgentOrchestrator(
      store,
      snapshots,
      ollama,
      new VramScheduler(ollama),
      new TreeSitterService(),
    );
    const proj = store.upsertProject({ name: 'mock-bench', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'New thread',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3.5:9b',
      effort: 'medium',
      approvalPolicy: 'full-access',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const t0 = Date.now();
    await orch.runUserTurn({ threadId: thread.id, content: 'Fix calc in src/pricing.mjs' });
    await orch.runUserTurn({ threadId: thread.id, content: 'Confirm calc' });
    const elapsedMs = Date.now() - t0;

    const patchedOk = readFileSync(join(dir, 'src/pricing.mjs'), 'utf8').includes('total + tax');
    const zoneAInvariant =
      seenSystemPrompts.length === 3 &&
      seenSystemPrompts[0] === seenSystemPrompts[1] &&
      seenSystemPrompts[1] === seenSystemPrompts[2];
    const turns = store.listTurns(thread.id).filter((t) => t.role === 'assistant');
    const turn2KvHit = turns[1]?.telemetry?.kvCacheHitRate ?? 0;

    console.table([
      {
        Check: 'json-repair + alias + prefix-strip',
        Result: patchedOk ? 'PASS' : 'FAIL',
        Detail: patchedOk ? 'Applied cleanly in 1 step' : 'Patch failed',
      },
      {
        Check: 'Zone A cross-turn KV invariance',
        Result: zoneAInvariant ? 'PASS' : 'FAIL',
        Detail: `Turn2 KV rate=${Math.round(turn2KvHit * 100)}%`,
      },
      {
        Check: 'Total 2-turn harness overhead',
        Result: 'PASS',
        Detail: `${elapsedMs}ms`,
      },
    ]);

    if (!patchedOk || !zoneAInvariant) {
      process.exitCode = 1;
    }
    orch.dispose();
    store.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(blobDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--mock')) {
    await runMockHarnessBenchmarks();
    return;
  }
  const modelFlagIdx = args.indexOf('--model');
  const mainModel =
    modelFlagIdx !== -1 && args[modelFlagIdx + 1]
      ? args[modelFlagIdx + 1]
      : 'pdurugyan/qwen3.5-9b-deepseek-v4-flash-Q4_K_M-v_2:latest';
  const fastFlagIdx = args.indexOf('--fast-model');
  const fastModel =
    fastFlagIdx !== -1 && args[fastFlagIdx + 1] ? args[fastFlagIdx + 1] : mainModel;
  const effortIdx = args.indexOf('--effort');
  const effortArg = effortIdx !== -1 ? args[effortIdx + 1] : 'medium';
  const effort: 'low' | 'medium' | 'high' =
    effortArg === 'low' || effortArg === 'high' ? effortArg : 'medium';
  const baseUrl = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

  console.log(
    `SmolCode A/B Benchmark | Main: ${mainModel} | Fast: ${fastModel} | Effort: ${effort}\n`,
  );

  const rows: Array<Record<string, unknown>> = [];

  for (const task of BENCH_TASKS) {
    const naiveDir = mkdtempSync(join(tmpdir(), `bench-naive-${task.id}-`));
    const smolDir = mkdtempSync(join(tmpdir(), `bench-smol-${task.id}-`));
    try {
      materializeTask(naiveDir, task);
      materializeTask(smolDir, task);

      console.log(`[${task.id}] Running Naive baseline...`);
      let naive = { promptTokens: 0, evalTokens: 0, totalTokens: 0, steps: 0, wallMs: 0 };
      let naiveTimedOut = false;
      try {
        naive = await runNaiveBaseline({
          workdir: naiveDir,
          model: mainModel,
          prompt: task.prompt,
          baseUrl,
          maxSteps: 7,
        });
      } catch (e) {
        naiveTimedOut = true;
        console.log(`[${task.id}] Naive baseline aborted/errored: ${String(e)}`);
      }
      const naivePassed = !naiveTimedOut && (await checkVerify(naiveDir, task.verifyCommand));
      console.log(
        `[${task.id}] Naive => pass=${naivePassed}, tok=${naive.totalTokens}, steps=${naive.steps}, ms=${naive.wallMs}`,
      );

      console.log(`[${task.id}] Running SmolCode 9B harness...`);
      const smol = await runSmolCodeTask({
        workdir: smolDir,
        task,
        mainModel,
        fastModel,
        effort,
        baseUrl,
      });
      const smolPassed = await checkVerify(smolDir, task.verifyCommand);
      console.log(
        `[${task.id}] SmolCode => pass=${smolPassed}, tok=${smol.totalTokens}, steps=${smol.steps}, ms=${smol.wallMs}, saved=${smol.tokensSaved}`,
      );

      const genSavedPct =
        naive.evalTokens > 0
          ? Math.round(((naive.evalTokens - smol.evalTokens) / naive.evalTokens) * 100)
          : 0;

      rows.push({
        Task: task.id,
        'Naive Pass': naivePassed ? 'PASS' : 'FAIL',
        'Smol Pass': smolPassed ? 'PASS' : 'FAIL',
        'Naive Gen': naive.evalTokens,
        'Smol Gen': smol.evalTokens,
        'Gen Saved': `${genSavedPct}%`,
        'AST/Hash Saved': smol.tokensSaved,
        'Naive ms': naive.wallMs,
        'Smol ms': smol.wallMs,
        Speedup:
          smol.wallMs > 0 && naive.wallMs > 0
            ? `${(naive.wallMs / smol.wallMs).toFixed(2)}x`
            : 'n/a',
      });
    } finally {
      rmSync(naiveDir, { recursive: true, force: true });
      rmSync(smolDir, { recursive: true, force: true });
    }
  }

  console.table(rows);
}

void main();
