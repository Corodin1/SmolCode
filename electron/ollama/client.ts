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
  };
  signal?: AbortSignal;
  onThinkingDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
}

export interface OllamaChatResponse {
  content: string;
  thinking: string;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  promptEvalCount: number;
  promptEvalDurationMs: number;
  evalCount: number;
  evalDurationMs: number;
}

function parseToolArgs(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class OllamaClient {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
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
    const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let promptEvalCount = 0;
    let promptEvalDurationMs = 0;
    let evalCount = 0;
    let evalDurationMs = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          const chunk = JSON.parse(line) as {
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
          };

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
              toolCalls.push({
                name: tc.function.name,
                arguments: parseToolArgs(tc.function.arguments),
              });
            }
          }
          if (chunk.done) {
            promptEvalCount = chunk.prompt_eval_count ?? 0;
            promptEvalDurationMs = Math.round((chunk.prompt_eval_duration ?? 0) / 1e6);
            evalCount = chunk.eval_count ?? 0;
            evalDurationMs = Math.round((chunk.eval_duration ?? 0) / 1e6);
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    }

    return {
      content,
      thinking,
      toolCalls,
      promptEvalCount,
      promptEvalDurationMs,
      evalCount,
      evalDurationMs,
    };
  }
}
