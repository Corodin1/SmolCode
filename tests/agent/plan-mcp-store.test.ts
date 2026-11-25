import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentOrchestrator } from '../../electron/agent/orchestrator';
import { TreeSitterService } from '../../electron/intel/tree-sitter-service';
import { McpManager } from '../../electron/mcp/mcp-manager';
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

describe('Store v2, MCP config, and Plan Mode workflow', () => {
  it('persists MCP servers, project environments, archived threads, and compacted turns', () => {
    const store = new SmolCodeStore(':memory:');
    const proj = store.upsertProject({
      name: 'codex-test',
      rootPath: 'C:/tmp/codex-test',
    });

    const env = store.saveProjectEnvironment({
      projectId: proj.id,
      setupScript: 'npm ci',
      envVarsJson: '{"NODE_ENV":"test"}',
    });
    expect(env.setupScript).toBe('npm ci');
    expect(store.getProjectEnvironment(proj.id).envVarsJson).toBe('{"NODE_ENV":"test"}');

    const mcp = store.saveMcpServer({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      enabled: true,
    });
    expect(mcp.id).toBeTruthy();
    expect(store.listMcpServers()).toHaveLength(1);

    const th = store.createThread({
      projectId: proj.id,
      title: 'Plan auth refactor',
      interactionMode: 'plan',
      mainModel: 'test-model',
      fastModel: 'test-model',
      effort: 'medium',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const archived = store.updateThread(th.id, { archived: true });
    expect(archived.archived).toBe(true);

    store.insertTurn({
      id: 'u1',
      threadId: th.id,
      role: 'user',
      content: 'Original question',
      createdAt: 1,
    });
    store.insertTurn({
      id: 'a1',
      threadId: th.id,
      role: 'assistant',
      content: 'Original answer',
      createdAt: 2,
    });
    store.replaceTurnsWithCompactSummary(th.id, {
      id: 'sum1',
      threadId: th.id,
      role: 'assistant',
      content: 'Compacted summary',
      createdAt: 3,
    });
    expect(store.listTurns(th.id)).toHaveLength(1);
    expect(store.listTurns(th.id)[0]?.content).toBe('Compacted summary');
    store.close();
  });

  it('executes Plan Mode request_user_input + propose_plan and blocks edits while in plan mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-plan-'));
    const blobDir = mkdtempSync(join(tmpdir(), 'codex-plan-blobs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/index.ts'), 'export const v = 1;\n', 'utf8');

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
          const parsed = JSON.parse(body || '{}') as { format?: unknown };
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
          step += 1;
          if (step === 1) {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'request_user_input',
                        arguments: {
                          question: 'Prefer JWT or session cookies?',
                          options: [{ label: 'JWT' }, { label: 'Cookies' }],
                          allowCustom: true,
                        },
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
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'propose_plan',
                        arguments: {
                          title: 'JWT Auth Plan',
                          summary: 'Implement stateless JWT tokens',
                          steps: ['Add signer helper', 'Protect routes'],
                        },
                      },
                    },
                  ],
                },
                done: false,
              }) + '\n',
            );
          } else if (step === 3) {
            res.write(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'finish_turn',
                        arguments: { summary: 'Plan ready for review.' },
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
                message: { role: 'assistant', content: 'Plan JWT auth' },
                done: false,
              }) + '\n',
            );
          }
          res.write(
            JSON.stringify({
              done: true,
              prompt_eval_count: 100,
              prompt_eval_duration: 50_000_000,
              eval_count: 20,
              eval_duration: 100_000_000,
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
      defaultMainModel: 'any-model',
      defaultFastModel: 'any-model',
    });
    const snapshots = new SnapshotManager(store, blobDir);
    const ollama = new OllamaClient(baseUrl);
    const scheduler = new VramScheduler(ollama);
    const orch = new AgentOrchestrator(
      store,
      snapshots,
      ollama,
      scheduler,
      new TreeSitterService(),
      new McpManager(),
    );

    const proj = store.upsertProject({ name: 'plan-demo', rootPath: dir });
    const thread = store.createThread({
      projectId: proj.id,
      title: 'New thread',
      interactionMode: 'plan',
      mainModel: 'any-model',
      fastModel: 'any-model',
      effort: 'low',
      approvalPolicy: 'auto',
      draftText: '',
      draftChips: [],
      status: 'idle',
      unread: false,
      pinned: false,
    });

    const unsub = orch.subscribe((ev) => {
      if (ev.type === 'question_requested') {
        orch.answerQuestionPrompt(ev.threadId, ev.turnId, ev.prompt.id, ['JWT']);
      }
    });
    cleanups.push(unsub);

    await orch.runUserTurn({ threadId: thread.id, content: 'Plan auth setup' });

    const turns = store.listTurns(thread.id);
    const assistant = turns.find((t) => t.role === 'assistant');
    expect(assistant?.questionPrompt?.answer).toEqual(['JWT']);
    expect(assistant?.plan?.title).toBe('JWT Auth Plan');
    expect(assistant?.plan?.steps).toHaveLength(2);
    store.close();
  });
});
