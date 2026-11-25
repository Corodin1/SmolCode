import type { LoadedOllamaModel, OllamaModelInfo } from '../../src/shared/types';

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  tools?: OllamaToolDef[];
  format?: Record<string, unknown> | 'json';
  think?: boolean;
  keep_alive?: string | number;
  options?: {
    num_ctx?: number;
    temperature?: number;
    num_gpu?: number;
    num_predict?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    repeat_penalty?: number;
    presence_penalty?: number;
    num_batch?: number;
    stop?: string[];
  };
  signal?: AbortSignal;
  onThinkingDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  parseError?: string;
}

export interface OllamaChatResponse {
  content: string;
  thinking: string;
  toolCalls: ParsedToolCall[];
  promptEvalCount: number;
  promptEvalDurationMs: number;
  evalCount: number;
  evalDurationMs: number;
  loadDurationMs: number;
  totalDurationMs: number;
}

/**
 * Escapes raw unescaped newlines/tabs inside JSON string literals and removes
 * trailing commas / unclosed braces commonly emitted by 4B-9B models.
 */
export function repairJsonString(input: string): string {
  let s = input.trim();
  // Strip optional markdown code fences
  const fenceMatch = s.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }

  let out = '';
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === '{') {
        stack.push('}');
        out += ch;
        continue;
      }
      if (ch === '[') {
        stack.push(']');
        out += ch;
        continue;
      }
      if (ch === '}' || ch === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop();
        }
        // Drop trailing comma right before closing bracket
        out = out.replace(/,\s*$/, '');
        out += ch;
        continue;
      }
      out += ch;
    }
  }

  if (inString) {
    out += '"';
  }
  out = out.replace(/,\s*$/, '');
  while (stack.length > 0) {
    out += stack.pop();
  }
  return out;
}

export function repairAndParseToolArgs(
  raw: Record<string, unknown> | string,
): { args: Record<string, unknown>; parseError?: string } {
  if (typeof raw !== 'string') {
    return {
      args: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {},
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { args: {} };

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, parseError: 'Tool arguments JSON must be an object.' };
  } catch {
    // Attempt deterministic repair
  }

  try {
    const repaired = repairJsonString(trimmed);
    const parsed = JSON.parse(repaired);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, parseError: 'Repaired tool arguments JSON was not an object.' };
  } catch (err) {
    return {
      args: {},
      parseError: `Invalid JSON arguments (${err instanceof Error ? err.message : String(err)}): ${trimmed.slice(0, 160)}`,
    };
  }
}

export class OllamaClient {
  private inspectCache = new Map<
    string,
    {
      at: number;
      promise: Promise<{
        capabilities: { tools: boolean; thinking: boolean; vision: boolean };
        contextLength: number;
      }>;
    }
  >();

  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
    this.inspectCache.clear();
  }

  getBaseUrl(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  async listModels(): Promise<OllamaModelInfo[]> {
    const res = await fetch(`${this.getBaseUrl()}/api/tags`);
    if (!res.ok) {
      throw new Error(`Ollama /api/tags failed (${res.status})`);
    }
    const data = (await res.json()) as {
      models?: Array<{
        name: string;
        size: number;
        details?: { parameter_size?: string; quantization_level?: string };
      }>;
    };
    const models = data.models ?? [];
    const enriched = await Promise.all(
      models.map(async (m) => {
        const caps = await this.inspectModel(m.name);
        return {
          name: m.name,
          sizeBytes: m.size ?? 0,
          parameterSize: m.details?.parameter_size ?? 'unknown',
          quantizationLevel: m.details?.quantization_level ?? 'unknown',
          capabilities: caps.capabilities,
          contextLength: caps.contextLength,
        } satisfies OllamaModelInfo;
      }),
    );
    return enriched;
  }

  async inspectModel(modelName: string): Promise<{
    capabilities: { tools: boolean; thinking: boolean; vision: boolean };
    contextLength: number;
  }> {
    const now = Date.now();
    const cached = this.inspectCache.get(modelName);
    if (cached && now - cached.at < 300_000) {
      return cached.promise;
    }

    const promise = (async () => {
      try {
        const res = await fetch(`${this.getBaseUrl()}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName }),
        });
        if (!res.ok) {
          return {
            capabilities: { tools: true, thinking: false, vision: false },
            contextLength: 32768,
          };
        }
        const data = (await res.json()) as {
          capabilities?: string[];
          model_info?: Record<string, unknown>;
        };
        const caps = new Set(data.capabilities ?? []);
        let contextLength = 32768;
        if (data.model_info) {
          for (const [key, val] of Object.entries(data.model_info)) {
            if (key.endsWith('.context_length') && typeof val === 'number') {
              contextLength = val;
              break;
            }
          }
        }
        return {
          capabilities: {
            tools: caps.has('tools'),
            thinking: caps.has('thinking'),
            vision: caps.has('vision'),
          },
          contextLength,
        };
      } catch {
        return {
          capabilities: { tools: true, thinking: false, vision: false },
          contextLength: 32768,
        };
      }
    })();

    this.inspectCache.set(modelName, { at: now, promise });
    return promise;
  }

  async listRunningModels(): Promise<LoadedOllamaModel[]> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/ps`);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{
          name: string;
          size?: number;
          size_vram?: number;
        }>;
      };
      return (data.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size ?? 0,
        sizeVramBytes: m.size_vram ?? 0,
      }));
    } catch {
      return [];
    }
  }

  async chatStream(req: OllamaChatRequest): Promise<OllamaChatResponse> {
    const execute = async (includeThink: boolean): Promise<Response> => {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        stream: true,
        keep_alive: req.keep_alive ?? -1,
        options: req.options ?? {},
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools;
      }
      if (req.format) {
        body.format = req.format;
      }
      if (includeThink && req.think !== undefined) {
        body.think = req.think;
      }
      return fetch(`${this.getBaseUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    };

    let response = await execute(true);
    if (!response.ok && response.status === 400 && req.think !== undefined) {
      const errText = await response.text();
      if (/think/i.test(errText)) {
        response = await execute(false);
      } else {
        throw new Error(`Ollama /api/chat failed (400): ${errText}`);
      }
    } else if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama /api/chat failed (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('Ollama /api/chat returned empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    const toolCalls: ParsedToolCall[] = [];
    let promptEvalCount = 0;
    let promptEvalDurationMs = 0;
    let evalCount = 0;
    let evalDurationMs = 0;
    let loadDurationMs = 0;
    let totalDurationMs = 0;

    const processLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      let chunk: {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: OllamaToolCall[];
        };
        done?: boolean;
        prompt_eval_count?: number;
        prompt_eval_duration?: number;
        eval_count?: number;
        eval_duration?: number;
        load_duration?: number;
        total_duration?: number;
      };
      try {
        chunk = JSON.parse(line);
      } catch {
        return;
      }

      if (chunk.message?.thinking) {
        thinking += chunk.message.thinking;
        req.onThinkingDelta?.(chunk.message.thinking);
      }
      if (chunk.message?.content) {
        content += chunk.message.content;
        req.onContentDelta?.(chunk.message.content);
      }
      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          const parsed = repairAndParseToolArgs(tc.function.arguments);
          toolCalls.push({
            name: tc.function.name,
            arguments: parsed.args,
            ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
          });
        }
      }
      if (chunk.done) {
        promptEvalCount = chunk.prompt_eval_count ?? 0;
        promptEvalDurationMs = Math.round((chunk.prompt_eval_duration ?? 0) / 1e6);
        evalCount = chunk.eval_count ?? 0;
        evalDurationMs = Math.round((chunk.eval_duration ?? 0) / 1e6);
        loadDurationMs = Math.round((chunk.load_duration ?? 0) / 1e6);
        totalDurationMs = Math.round((chunk.total_duration ?? 0) / 1e6);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer);
    }

    return {
      content,
      thinking,
      toolCalls,
      promptEvalCount,
      promptEvalDurationMs,
      evalCount,
      evalDurationMs,
      loadDurationMs,
      totalDurationMs,
    };
  }
}
