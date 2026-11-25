import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentOrchestrator } from '../../electron/agent/orchestrator';
import { lineHash } from '../../electron/intel/hashline';
import { TreeSitterService } from '../../electron/intel/tree-sitter-service';
import { OllamaClient } from '../../electron/ollama/client';
import { VramScheduler } from '../../electron/ollama/vram-scheduler';
import { SmolCodeStore } from '../../electron/store/database';
import { SnapshotManager } from '../../electron/store/snapshots';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('4-Stage AgentOrchestrator integration (mock Ollama server)', () => {
  it('runs Fast Scout -> Hashline Patch -> Syntax Auto-Verify -> Snapshot Rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-orch-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-orch-blobs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    const targetFile = join(dir, 'src/calc.ts');
    writeFileSync(
      targetFile,
      'export function add(a: number, b: number) {\n  return a - b;\n}\n',
      'utf8',
    );
    const bugHash = lineHash('  return a - b;');

    let chatCallIdx = 0;
    const server: Server = createServer((req, res) => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities: ['tools', 'thinking'] }));
        return;
      }
      if (req.url === '/api/chat') {
        let body = '';
        req.on('data', (c) => (body += String(c)));
        req.on('end', () => {
          chatCallIdx += 1;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

          if (chatCallIdx === 1) {
            // Stage 2: Fast Scout JSON selection
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    targets: [{ filePath: 'src/calc.ts', symbolName: 'add' }],
                    searchQueries: [],
                    directAnswerPossible: false,
                  }),
                },
                done: false,
              }) + '\n',
            );
          } else if (chatCallIdx === 2) {
            // Stage 3 step 1: Main model calls patch_hashline using anchored line hash
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  thinking: 'Line 2 subtracts instead of adding.',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'patch_hashline',
                        arguments: {
                          filePath: 'src/calc.ts',
                          edits: [
                            {
                              op: 'replace_range',
                              startAnchor: `2:${bugHash}`,
                              endAnchor: `2:${bugHash}`,
                              content: '  return a + b;',
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else if (chatCallIdx === 3) {
            // Stage 3 step 2: finish_turn
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'finish_turn',
                        arguments: { summary: 'Fixed addition operator in src/calc.ts.' },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else {
            // Stage 4: Thread title generation
            res.write(
              JSON.stringify({
                message: { role: 'assistant', content: 'Fix add helper math' },
                done: false,
              }) + '\n',
            );
          }

          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 420,
              prompt_eval_duration: 180_000_000,
              eval_count: 48,
              eval_duration: 600_000_000,
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
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

    const store = new SmolCodeStore(':memory:');
    store.updateSettings({
      ollamaBaseUrl: baseUrl,
      defaultMainModel: 'qwen3.5:9b',
      defaultFastModel: 'qwen3:1.7b',
    });
    const snapshots = new SnapshotManager(store, blobDir);
    const ollama = new OllamaClient(baseUrl);
    const scheduler = new VramScheduler(ollama);
    const ts = new TreeSitterService();
    const orch = new AgentOrchestrator(store, snapshots, ollama, scheduler, ts);

    const proj = store.upsertProject({ name: 'demo', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'New thread',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3:1.7b',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });
    // Force scout active for this test by using medium effort
    store.updateThread(thread.id, { effort: 'medium' });

    const observedTools: string[] = [];
    const unsub = orch.subscribe((ev) => {
      if (ev.type === 'tool_update') observedTools.push(`${ev.tool.toolName}:${ev.tool.status}`);
    });

    await orch.runUserTurn({ threadId: thread.id, content: 'Fix the add bug' });
    unsub();

    expect(observedTools).toContain('fast_scout:ok');
    expect(observedTools).toContain('patch_hashline:ok');

    expect(readFileSync(targetFile, 'utf8')).toContain('return a + b;');
    const turns = store.listTurns(thread.id);
    const assistant = turns.find((t) => t.role === 'assistant');
    expect(assistant?.content).toContain('Fixed addition operator');
    expect(assistant?.telemetry?.tokensSavedByAst).toBeGreaterThanOrEqual(0);
    expect(store.getThread(thread.id)?.title).toBe('Fix add helper math');

    // Verify per-turn snapshot restores original buggy file cleanly
    expect(assistant?.snapshotId).toBeTruthy();
    snapshots.restoreSnapshot(assistant!.snapshotId!);
    expect(readFileSync(targetFile, 'utf8')).toContain('return a - b;');
    store.close();
  });

  it('emits Stage 1 prefetch read_range tool_update events for explicitly mentioned files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-prefetch-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-prefetch-blobs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/calc.ts'), 'export const x = 1;\n', 'utf8');

    const server: Server = createServer((req, res) => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities: ['tools'] }));
        return;
      }
      if (req.url === '/api/chat') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(
            JSON.stringify({
              message: { role: 'assistant', content: 'Looked at src/calc.ts.' },
              done: false,
            }) + '\n',
          );
          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 80,
              prompt_eval_duration: 20_000_000,
              eval_count: 10,
              eval_duration: 50_000_000,
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
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

    const store = new SmolCodeStore(':memory:');
    store.updateSettings({
      ollamaBaseUrl: baseUrl,
      defaultMainModel: 'qwen3.5:9b',
      defaultFastModel: 'qwen3:1.7b',
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

    const proj = store.upsertProject({ name: 'prefetch-demo', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'Inspect calc',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3:1.7b',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const prefetched: Array<{ toolName: string; filePath?: string; status: string }> = [];
    const unsub = orch.subscribe((ev) => {
      if (ev.type === 'tool_update') {
        prefetched.push({
          toolName: ev.tool.toolName,
          filePath: ev.tool.filePath,
          status: ev.tool.status,
        });
      }
    });

    await orch.runUserTurn({ threadId: thread.id, content: 'Inspect src/calc.ts' });
    unsub();

    expect(prefetched).toContainEqual({
      toolName: 'read_range',
      filePath: 'src/calc.ts',
      status: 'ok',
    });
    orch.dispose();
    store.close();
  });

  it('supports non-tool models via <tool_call> fallback, parallel read-only batches, live plan progress, and ZoneA structural refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-orch-adv-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-orch-adv-blobs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 2;\n', 'utf8');

    const seenChatBodies: Array<{ tools?: unknown[]; messages: Array<{ role: string; content: string }> }> = [];
    let chatCallIdx = 0;

    const server: Server = createServer((req, res) => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Non-tool-capable model
        res.end(JSON.stringify({ capabilities: ['completion'] }));
        return;
      }
      if (req.url === '/api/chat') {
        let body = '';
        req.on('data', (c) => (body += String(c)));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}') as {
            format?: unknown;
            tools?: unknown[];
            messages: Array<{ role: string; content: string }>;
          };
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

          if (parsed.format) {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: JSON.stringify({ targets: [], searchQueries: [], directAnswerPossible: false }),
                },
                done: false,
              }) + '\n',
            );
            res.write(JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 10 }) + '\n');
            res.end();
            return;
          }

          chatCallIdx += 1;
          seenChatBodies.push(parsed);

          if (chatCallIdx === 1) {
            // Non-tool model emits parallel read-only <tool_call> batch
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content:
                    '<tool_call>{"name":"read_range","arguments":{"filePath":"src/a.ts","startLine":1,"endLine":5}}</tool_call>\n' +
                    '<tool_call>{"name":"read_range","arguments":{"filePath":"src/b.ts","startLine":1,"endLine":5}}</tool_call>',
                },
                done: false,
              }) + '\n',
            );
          } else if (chatCallIdx === 2) {
            // Update plan step 1 -> done, create_file -> refreshes Zone A on next turn
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content:
                    '<tool_call>{"name":"update_plan_step","arguments":{"stepId":"step-1","status":"done"}}</tool_call>\n' +
                    '<tool_call>{"name":"create_file","arguments":{"filePath":"src/c.ts","content":"export const c = 3;\\n"}}</tool_call>',
                },
                done: false,
              }) + '\n',
            );
          } else if (chatCallIdx === 3) {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '<tool_call>{"name":"finish_turn","arguments":{"summary":"Created src/c.ts."}}</tool_call>',
                },
                done: false,
              }) + '\n',
            );
          } else {
            res.write(
              JSON.stringify({
                message: { role: 'assistant', content: 'Follow-up complete.' },
                done: false,
              }) + '\n',
            );
          }
          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 100,
              prompt_eval_duration: 10_000_000,
              eval_count: 20,
              eval_duration: 20_000_000,
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
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

    const store = new SmolCodeStore(':memory:');
    store.updateSettings({
      ollamaBaseUrl: baseUrl,
      defaultMainModel: 'llama3.1:8b',
      defaultFastModel: 'llama3.1:8b',
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

    const proj = store.upsertProject({ name: 'adv-demo', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'Plan build',
      interactionMode: 'build',
      mainModel: 'llama3.1:8b',
      fastModel: 'llama3.1:8b',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    // Seed an approved plan on a prior turn
    store.insertTurn({
      id: 'plan-turn-1',
      threadId: thread.id,
      role: 'assistant',
      content: 'Plan ready.',
      plan: {
        id: 'plan-1',
        title: 'Add module C',
        summary: 'Inspect A and B, then add C',
        approved: true,
        steps: [
          { id: 'step-1', title: 'Inspect modules', status: 'pending' },
          { id: 'step-2', title: 'Create C', status: 'pending' },
        ],
      },
      createdAt: Date.now() - 1000,
    });

    const planUpdates: Array<Array<string>> = [];
    const unsub = orch.subscribe((ev) => {
      if (ev.type === 'plan_updated') {
        planUpdates.push(ev.plan.steps.map((s) => `${s.id}:${s.status}`));
      }
    });

    await orch.runUserTurn({ threadId: thread.id, content: 'Implement the plan' });

    // Non-tool model did NOT receive native `tools` param, got <tool_call> instructions in Zone A
    expect(seenChatBodies[0].tools).toBeUndefined();
    expect(seenChatBodies[0].messages[0].content).toContain('<tool_call>');
    // Zone A remained identical across steps of turn 1
    expect(seenChatBodies[0].messages[0].content).toBe(seenChatBodies[1].messages[0].content);

    // Parallel read-only batch preserved deterministic order
    const turns = store.listTurns(thread.id);
    const lastTurn = turns[turns.length - 1];
    const readLogs = (lastTurn.toolCalls ?? []).filter((t) => t.toolName === 'read_range');
    expect(readLogs.map((r) => r.filePath)).toEqual(['src/a.ts', 'src/b.ts']);

    // Plan streamed in_progress -> step-1 done -> auto-completed remaining steps on finish_turn
    expect(planUpdates.length).toBeGreaterThanOrEqual(2);
    const finalPlanTurn = store.listTurns(thread.id).find((t) => t.id === 'plan-turn-1');
    expect(finalPlanTurn?.plan?.steps.every((s) => s.status === 'done')).toBe(true);

    // Next turn refreshes Zone A skeleton incrementally because src/c.ts was created
    await orch.runUserTurn({ threadId: thread.id, content: 'Verify workspace' });
    unsub();
    const turn2System = seenChatBodies[seenChatBodies.length - 1].messages[0].content;
    expect(turn2System).toContain('src/c.ts');

    orch.dispose();
    store.close();
  });

  it('injects Available Skills in Zone A, prefetches skill chips, executes read_skill/save_skill, and emits skills_updated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-skill-orch-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-skill-orch-blobs-'));
    mkdirSync(join(dir, '.smolcode', 'skills', 'demo-guide'), { recursive: true });
    writeFileSync(
      join(dir, '.smolcode', 'skills', 'demo-guide', 'SKILL.md'),
      '---\nname: demo-guide\ndescription: Demo workflow guide\n---\n\nAlways check step X and step Y.\n',
      'utf8',
    );
    writeFileSync(join(dir, 'index.ts'), 'export const v = 1;\n', 'utf8');

    const chatPrompts: string[] = [];
    let chatCallIdx = 0;

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
            format?: unknown;
            messages: Array<{ role: string; content: string }>;
          };
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

          if (parsed.format) {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: JSON.stringify({ targets: [], searchQueries: [], directAnswerPossible: false }),
                },
                done: false,
              }) + '\n',
            );
            res.write(JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 10 }) + '\n');
            res.end();
            return;
          }

          chatCallIdx += 1;
          chatPrompts.push(parsed.messages.map((m) => `${m.role}:${m.content}`).join('\n---\n'));

          if (chatCallIdx === 1) {
            // Read a built-in skill & save a new repo skill
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    { function: { name: 'read_skill', arguments: { name: 'skill-creator' } } },
                    {
                      function: {
                        name: 'save_skill',
                        arguments: {
                          name: 'repo-release',
                          description: 'Build and release checklist',
                          scope: 'repo',
                          content: '## Steps\n1. Run npm run build.',
                        },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else if (chatCallIdx === 2) {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'finish_turn',
                        arguments: { summary: 'Saved repo-release skill.' },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else {
            res.write(
              JSON.stringify({
                message: { role: 'assistant', content: 'Ready to use /repo-release.' },
                done: false,
              }) + '\n',
            );
          }
          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 100,
              prompt_eval_duration: 10_000_000,
              eval_count: 15,
              eval_duration: 15_000_000,
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
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

    const store = new SmolCodeStore(':memory:');
    store.updateSettings({
      ollamaBaseUrl: baseUrl,
      defaultMainModel: 'qwen3.5:9b',
      defaultFastModel: 'qwen3:1.7b',
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

    const proj = store.upsertProject({ name: 'skill-demo', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'Skill workflow',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3:1.7b',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const updatedSkillNames: string[][] = [];
    const unsub = orch.subscribe((ev) => {
      if (ev.type === 'skills_updated') {
        updatedSkillNames.push(ev.skills.map((s) => s.name));
      }
    });

    await orch.runUserTurn({
      threadId: thread.id,
      content: 'Create a release skill',
      chips: [{ id: 'skill:demo-guide', kind: 'skill', label: '/demo-guide', skillName: 'demo-guide' }],
    });

    // Zone A had Available Skills catalog and Stage 1 prefetched full /demo-guide
    expect(chatPrompts[0]).toContain('Available Skills');
    expect(chatPrompts[0]).toContain('demo-guide [repo]');
    expect(chatPrompts[0]).toContain('Always check step X and step Y.');

    // save_skill wrote SKILL.md and emitted skills_updated
    expect(updatedSkillNames.length).toBeGreaterThanOrEqual(1);
    expect(updatedSkillNames[0]).toContain('repo-release');

    // Turn 2 refreshes Zone A catalog automatically with the newly created skill
    await orch.runUserTurn({ threadId: thread.id, content: 'Confirm skills' });
    unsub();
    expect(chatPrompts[chatPrompts.length - 1]).toContain('repo-release [repo]');

    orch.dispose();
    store.close();
  });

  it('prompts write_outside_root approval in auto mode and caches allow-session dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-outside-ws-'));
    const extDir = mkdtempSync(join(tmpdir(), 'smolcode-outside-target-'));
    const extDir2 = mkdtempSync(join(tmpdir(), 'smolcode-outside-target2-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-outside-blobs-'));

    const fileDenied = join(extDir, 'denied.txt');
    const fileSession = join(extDir, 'session.txt');
    const fileCached = join(extDir, 'cached.txt');
    const fileFullAccess = join(extDir2, 'full.txt');
    const fileReadOnly = join(extDir2, 'readonly.txt');

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
          step += 1;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          let msg: Record<string, unknown>;

          if (step === 1) {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'create_file', arguments: { filePath: fileDenied, content: 'no\n' } } }],
            };
          } else if (step === 2) {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'create_file', arguments: { filePath: fileSession, content: 'yes-1\n' } } }],
            };
          } else if (step === 3) {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'create_file', arguments: { filePath: fileCached, content: 'yes-2\n' } } }],
            };
          } else if (step === 4) {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'finish_turn', arguments: { summary: 'Done turn 1' } } }],
            };
          } else if (step === 5) {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'create_file', arguments: { filePath: fileFullAccess, content: 'full\n' } } }],
            };
          } else if (step === 6) {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'finish_turn', arguments: { summary: 'Done full-access' } } }],
            };
          } else if (step === 7) {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'create_file', arguments: { filePath: fileReadOnly, content: 'blocked\n' } } }],
            };
          } else {
            msg = {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'finish_turn', arguments: { summary: 'Done read-only' } } }],
            };
          }

          res.write(JSON.stringify({ message: msg, done: false }) + '\n');
          res.write(JSON.stringify({ done: true, prompt_eval_count: 80, eval_count: 16 }) + '\n');
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(extDir, { recursive: true, force: true }),
      () => rmSync(extDir2, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

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

    const proj = store.upsertProject({ name: 'outside-demo', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'Outside write test',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3.5:9b',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const requestedApprovals: string[] = [];
    const unsub = orch.subscribe((ev) => {
      if (ev.type === 'approval_requested') {
        requestedApprovals.push(`${ev.request.kind}:${ev.request.commandOrPath}`);
        queueMicrotask(() => {
          orch.resolveApproval(
            ev.request.id,
            requestedApprovals.length === 1 ? 'deny' : 'allow-session',
          );
        });
      }
    });

    // Turn 1 (auto): 1st request denied, 2nd allow-session, 3rd reuses cached session dir
    await orch.runUserTurn({ threadId: thread.id, content: 'Write outside files' });
    expect(requestedApprovals).toHaveLength(2);
    expect(requestedApprovals[0]).toMatch(/^write_outside_root:/);
    expect(existsSync(fileDenied)).toBe(false);
    expect(readFileSync(fileSession, 'utf8')).toBe('yes-1\n');
    expect(readFileSync(fileCached, 'utf8')).toBe('yes-2\n');

    // Turn 2 (full-access): writes to a new external dir without prompting
    store.updateThread(thread.id, { approvalPolicy: 'full-access' });
    await orch.runUserTurn({ threadId: thread.id, content: 'Write anywhere' });
    expect(requestedApprovals).toHaveLength(2);
    expect(readFileSync(fileFullAccess, 'utf8')).toBe('full\n');

    // Turn 3 (read-only): refuses without prompting
    store.updateThread(thread.id, { approvalPolicy: 'read-only' });
    await orch.runUserTurn({ threadId: thread.id, content: 'Try read-only write' });
    expect(requestedApprovals).toHaveLength(2);
    expect(existsSync(fileReadOnly)).toBe(false);

    unsub();
    orch.dispose();
    store.close();
  });

  it('repairs malformed tool JSON, supports <function=...> XML + path aliases, gates create_file syntax, blocks finish_turn on step error, and preserves Zone A across turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-orch-glitch-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-orch-glitch-blobs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/math.ts'),
      'export function mul(a: number, b: number): number {\n  return a + b;\n}\n',
      'utf8',
    );
    const badLineHash = lineHash('  return a + b;');

    const seenRequests: Array<{
      tools?: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; content: string }>;
    }> = [];
    let callIdx = 0;

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
            tools?: Array<{ function: { name: string } }>;
            messages: Array<{ role: string; content: string }>;
          };
          seenRequests.push(parsed);
          callIdx += 1;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

          if (callIdx === 1) {
            // Step 1: atomic create_file syntax rejection + finish_turn in same step (finish_turn must be blocked!)
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'create_file',
                        arguments: { filePath: 'src/broken.ts', content: 'export function bad( {\n' },
                      },
                    },
                    {
                      function: {
                        name: 'finish_turn',
                        arguments: { summary: 'Premature finish' },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else if (callIdx === 2) {
            // Step 2: malformed JSON string with unescaped newline + trailing comma, plus `path` alias + copied `2:xx| ` prefix
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'patch_hashline',
                        arguments: `{"path":"src/math.ts","edits":[{"op":"replace_range","startAnchor":"L2:${badLineHash}","endAnchor":"2:${badLineHash}","content":"2:${badLineHash}|   return a * b;\n",}],}`,
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else if (callIdx === 3) {
            // Step 3: Qwen XML <function=finish_turn> fallback
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content:
                    '<function=finish_turn><parameter=summary>Fixed mul operator cleanly.</parameter></function>',
                },
                done: false,
              }) + '\n',
            );
          } else {
            // Turn 2: direct answer
            res.write(
              JSON.stringify({
                message: { role: 'assistant', content: 'Turn 2 verified.' },
                done: false,
              }) + '\n',
            );
          }
          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 150,
              prompt_eval_duration: 15_000_000,
              eval_count: 25,
              eval_duration: 25_000_000,
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

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

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

    const proj = store.upsertProject({ name: 'glitch-demo', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'New thread',
      interactionMode: 'build',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3.5:9b',
      effort: 'medium',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    await orch.runUserTurn({ threadId: thread.id, content: 'Fix mul in src/math.ts' });

    // Broken file was rejected BEFORE hitting disk
    expect(existsSync(join(dir, 'src/broken.ts'))).toBe(false);
    // Patch succeeded after repairing JSON + path alias + stripping copied line:hash| prefix
    expect(readFileSync(join(dir, 'src/math.ts'), 'utf8')).toContain('return a * b;');
    // Build mode pruned propose_plan
    const sentToolNames = (seenRequests[0].tools ?? []).map((t) => t.function.name);
    expect(sentToolNames).not.toContain('propose_plan');
    // Single-model heuristic title avoided an extra Stage 4 LLM call
    expect(callIdx).toBe(3);
    expect(store.getThread(thread.id)?.title).toContain('Fix mul');

    // Turn 2: Zone A system prompt stays 100% byte-identical across turns
    await orch.runUserTurn({ threadId: thread.id, content: 'Check mul again' });
    expect(seenRequests[3].messages[0].content).toBe(seenRequests[0].messages[0].content);

    orch.dispose();
    store.close();
  });

  it('executes raw <file_write> and <replace_symbol> pastes and finalizes parallel batch logs on LoopGuard halt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-paste-orch-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-paste-blobs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/helper.ts'),
      'export function calc(x: number) {\n  return x + 1;\n}\n',
      'utf8',
    );

    let chatCallIdx = 0;
    const server: Server = createServer((req, res) => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities: ['tools'] }));
        return;
      }
      if (req.url === '/api/chat') {
        req.on('data', () => {});
        req.on('end', () => {
          chatCallIdx += 1;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

          if (chatCallIdx === 1) {
            // Turn 1 Step 1: stream raw <file_write> + <replace_symbol> in prose
            const payload =
              'Applying changes.\n<file_write path="src/extra.ts">\nexport const factor = 2;\n</file_write>\n<replace_symbol path="src/helper.ts" symbol="calc">\nexport function calc(x: number) {\n  return x * 2;\n}\n</replace_symbol>\nAll written.';
            res.write(
              JSON.stringify({ message: { role: 'assistant', content: payload }, done: false }) + '\n',
            );
          } else if (chatCallIdx === 2) {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    { function: { name: 'finish_turn', arguments: { summary: 'Applied raw code pastes cleanly.' } } },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else if (chatCallIdx === 3 || chatCallIdx === 4) {
            // Turn 2: repeat identical read_range 3x across 2 steps (2x in step 1 + 1x in step 2)
            // with another read_range after it in the same parallel batch to verify zero 'running' orphans
            const calls =
              chatCallIdx === 3
                ? [
                    { function: { name: 'read_range', arguments: { filePath: 'src/helper.ts', startLine: 1, endLine: 3 } } },
                    { function: { name: 'read_range', arguments: { filePath: 'src/helper.ts', startLine: 1, endLine: 3 } } },
                  ]
                : [
                    { function: { name: 'read_range', arguments: { filePath: 'src/helper.ts', startLine: 1, endLine: 3 } } },
                    { function: { name: 'read_range', arguments: { filePath: 'src/extra.ts', startLine: 1, endLine: 1 } } },
                  ];
            res.write(
              JSON.stringify({
                message: { role: 'assistant', content: '', tool_calls: calls },
                done: false,
              }) + '\n',
            );
          } else {
            res.write(
              JSON.stringify({ message: { role: 'assistant', content: 'Done.' }, done: false }) + '\n',
            );
          }

          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 100,
              prompt_eval_duration: 10_000_000,
              eval_count: 20,
              eval_duration: 20_000_000,
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

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

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

    const proj = store.upsertProject({ name: 'paste-orch', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'New thread',
      interactionMode: 'build',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3.5:9b',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const streamedDeltas: string[] = [];
    const unsub = orch.subscribe((ev) => {
      if (ev.type === 'content_delta') streamedDeltas.push(ev.delta);
    });

    await orch.runUserTurn({ threadId: thread.id, content: 'Create extra and update helper' });
    unsub();

    expect(readFileSync(join(dir, 'src/extra.ts'), 'utf8')).toBe('export const factor = 2;\n');
    expect(readFileSync(join(dir, 'src/helper.ts'), 'utf8')).toContain('return x * 2;');
    // Raw code tags must NOT leak into live streamed prose
    expect(streamedDeltas.join('')).not.toContain('export const factor = 2');
    expect(streamedDeltas.join('')).toContain('Applying changes.');

    // Turn 2: parallel batch LoopGuard halt leaves zero toolCalls stuck in 'running'
    await orch.runUserTurn({ threadId: thread.id, content: 'Loop read test' });
    const turns = store.listTurns(thread.id);
    const lastAssistant = turns[turns.length - 1];
    expect(lastAssistant.content).toContain('Stopped repeated identical call to "read_range"');
    expect((lastAssistant.toolCalls ?? []).some((t) => t.status === 'running')).toBe(false);

    orch.dispose();
    store.close();
  });

  it('normalizes patch_hashline single-object startLine/endLine/newContent and old_text/new_text fallbacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-alias-orch-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'smolcode-alias-blobs-'));
    writeFileSync(join(dir, 'main.py'), 'def a():\n    return 1\n\ndef b():\n    return 2\n', 'utf8');

    let step = 0;
    const server: Server = createServer((req, res) => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities: ['tools'] }));
        return;
      }
      if (req.url === '/api/chat') {
        req.on('data', () => {});
        req.on('end', () => {
          step += 1;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          if (step === 1) {
            // Single object `edits` using startLine/endLine/newContent aliases
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'patch_hashline',
                        arguments: {
                          path: 'main.py',
                          edits: {
                            op: 'replace_range',
                            startLine: 2,
                            endLine: 2,
                            newContent: '    return 10',
                          },
                        },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else if (step === 2) {
            // patch_hashline called with snake_case old_text / new_text instead of edits
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'patch_hashline',
                        arguments: {
                          filePath: 'main.py',
                          old_text: '    return 2',
                          new_text: '    return 20',
                        },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{ function: { name: 'finish_turn', arguments: { summary: 'Updated main.py.' } } }],
                },
                done: false,
              }) + '\n',
            );
          }
          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 80,
              prompt_eval_duration: 10_000_000,
              eval_count: 15,
              eval_duration: 15_000_000,
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
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
      () => rmSync(dir, { recursive: true, force: true }),
      () => rmSync(blobDir, { recursive: true, force: true }),
    );

    const store = new SmolCodeStore(':memory:');
    store.updateSettings({
      ollamaBaseUrl: baseUrl,
      defaultMainModel: 'qwen3.5:9b',
      defaultFastModel: 'qwen3.5:9b',
    });
    const ollama = new OllamaClient(baseUrl);
    const orch = new AgentOrchestrator(
      store,
      new SnapshotManager(store, blobDir),
      ollama,
      new VramScheduler(ollama),
      new TreeSitterService(),
    );
    const proj = store.upsertProject({ name: 'alias-orch', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'New thread',
      interactionMode: 'build',
      mainModel: 'qwen3.5:9b',
      fastModel: 'qwen3.5:9b',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    await orch.runUserTurn({ threadId: thread.id, content: 'Update main.py' });
    const finalText = readFileSync(join(dir, 'main.py'), 'utf8');
    expect(finalText).toContain('return 10');
    expect(finalText).toContain('return 20');

    orch.dispose();
    store.close();
  });
});
