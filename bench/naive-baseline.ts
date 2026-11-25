import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { OllamaClient, type OllamaChatMessage, type OllamaToolDef } from '../electron/ollama/client';

const execAsync = promisify(exec);

const NAIVE_TOOLS: OllamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files in workspace',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read entire file contents',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_file',
      description: 'Replace exact oldText with newText in a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

function walkAllFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkAllFiles(full, root));
    else out.push(relative(root, full).replace(/\\/g, '/'));
  }
  return out;
}

export interface BenchRunMetrics {
  promptTokens: number;
  evalTokens: number;
  totalTokens: number;
  steps: number;
  wallMs: number;
}

export async function runNaiveBaseline(params: {
  workdir: string;
  model: string;
  prompt: string;
  baseUrl?: string;
  maxSteps?: number;
}): Promise<BenchRunMetrics> {
  const client = new OllamaClient(params.baseUrl ?? 'http://127.0.0.1:11434');
  const maxSteps = params.maxSteps ?? 10;
  const started = Date.now();
  let promptTokens = 0;
  let evalTokens = 0;
  let steps = 0;

  const messages: OllamaChatMessage[] = [
    {
      role: 'system',
      content: `You are a coding assistant in ${params.workdir}. Inspect files, fix the issue using replace_file, and verify with run_command.`,
    },
    { role: 'user', content: params.prompt },
  ];

  for (let i = 0; i < maxSteps; i++) {
    steps += 1;
    // Mutate system prompt timestamp like naive harnesses that break KV prefix caching
    messages[0] = {
      role: 'system',
      content: `You are a coding assistant in ${params.workdir}. Step ${i + 1}/${maxSteps}. Inspect files, fix the issue using replace_file, and verify with run_command.`,
    };

    const resp = await client.chatStream({
      model: params.model,
      think: true,
      keep_alive: -1,
      options: { num_ctx: 8192, temperature: 0.2, num_predict: 1536 },
      tools: NAIVE_TOOLS,
      messages,
      signal: AbortSignal.timeout(45_000),
    });
    promptTokens += resp.promptEvalCount;
    evalTokens += resp.evalCount;

    if (resp.toolCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: resp.content,
      tool_calls: resp.toolCalls.map((t) => ({
        function: { name: t.name, arguments: t.arguments },
      })),
    });

    for (const tc of resp.toolCalls) {
      let result = '';
      try {
        if (tc.name === 'list_files') {
          result = walkAllFiles(params.workdir).join('\n');
        } else if (tc.name === 'read_file') {
          const p = join(params.workdir, String(tc.arguments.path ?? ''));
          result = existsSync(p) ? readFileSync(p, 'utf8') : 'File not found';
        } else if (tc.name === 'replace_file') {
          const p = join(params.workdir, String(tc.arguments.path ?? ''));
          const oldText = String(tc.arguments.oldText ?? '');
          const newText = String(tc.arguments.newText ?? '');
          if (!existsSync(p)) {
            result = 'File not found';
          } else {
            const cur = readFileSync(p, 'utf8');
            if (!cur.includes(oldText)) {
              result = 'Error: oldText did not match exactly in file.';
            } else {
              mkdirSync(dirname(p), { recursive: true });
              writeFileSync(p, cur.replace(oldText, newText), 'utf8');
              result = 'File updated.';
            }
          }
        } else if (tc.name === 'run_command') {
          try {
            const { stdout, stderr } = await execAsync(String(tc.arguments.command ?? ''), {
              cwd: params.workdir,
              timeout: 30_000,
            });
            result = [stdout, stderr].filter(Boolean).join('\n') || 'exit 0';
          } catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            result = [err.stdout ?? '', err.stderr ?? '', err.message ?? ''].join('\n');
          }
        }
      } catch (e) {
        result = String(e);
      }
      messages.push({ role: 'tool', tool_name: tc.name, content: result });
    }
  }

  return {
    promptTokens,
    evalTokens,
    totalTokens: promptTokens + evalTokens,
    steps,
    wallMs: Date.now() - started,
  };
}
