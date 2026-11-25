import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AppSettings,
  EffortLevel,
  OllamaModelInfo,
  VramStatus,
} from '../../src/shared/types';
import type { OllamaClient } from './client';
import { getEffortProfile } from './effort-profiles';

const execFileAsync = promisify(execFile);

export type TurnPriority = 0 | 1 | 2; // 0 = foreground active, 1 = queued user, 2 = background automation

interface QueueEntry {
  threadId: string;
  priority: TurnPriority;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface RoleCallOptions {
  model: string;
  think?: boolean;
  keepAlive: number;
  options: {
    num_ctx: number;
    temperature: number;
    num_predict?: number;
    num_gpu?: number;
    top_p?: number;
    min_p?: number;
    repeat_penalty?: number;
    presence_penalty?: number;
    num_batch?: number;
  };
}

export function parseModelBillionParams(
  modelName: string,
  modelInfo?: OllamaModelInfo,
): number | null {
  const paramStr = modelInfo?.parameterSize ?? '';
  const match =
    paramStr.match(/(\d+(?:\.\d+)?)\s*([bm])/i) ??
    modelName.match(/[:-](\d+(?:\.\d+)?)\s*([bm])\b/i);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  return match[2].toLowerCase() === 'm' ? num / 1000 : num;
}

export function inferModelSamplingProfile(
  modelName: string,
  modelInfo: OllamaModelInfo | undefined,
  thinkEnabled: boolean,
  baseTemperature: number,
): {
  allowThink: boolean;
  temperature: number;
  top_p: number;
  min_p: number;
  repeat_penalty: number;
  presence_penalty?: number;
  num_batch: number;
} {
  const lower = modelName.toLowerCase();
  const paramsB = parseModelBillionParams(modelName, modelInfo);
  const isTiny = paramsB !== null && paramsB <= 4.2;
  const isThinkingFamily =
    lower.includes('qwen3') || lower.includes('deepseek') || lower.includes('r1');
  const supportsThink = modelInfo?.capabilities.thinking ?? true;
  // Auto-disable thinking on <=4B models unless explicitly supported and large enough
  const allowThink = supportsThink && thinkEnabled && !isTiny;

  if (allowThink && isThinkingFamily) {
    return {
      allowThink,
      temperature: Math.max(baseTemperature, 0.25),
      top_p: 0.95,
      min_p: 0.05,
      repeat_penalty: 1.06,
      presence_penalty: 0.4,
      num_batch: 512,
    };
  }

  return {
    allowThink,
    temperature: baseTemperature,
    top_p: 0.9,
    min_p: 0.05,
    repeat_penalty: 1.08,
    num_batch: 512,
  };
}

export class VramScheduler {
  private queue: QueueEntry[] = [];
  private activeThreadId: string | null = null;
  private cachedGpuSample: { at: number; totalMb: number; freeMb: number } | null = null;
  private queueListeners = new Set<
    (state: { activeThreadId: string | null; queuedThreadIds: string[] }) => void
  >();

  constructor(private readonly client: OllamaClient) {}

  onQueueChange(
    cb: (state: { activeThreadId: string | null; queuedThreadIds: string[] }) => void,
  ): () => void {
    this.queueListeners.add(cb);
    return () => this.queueListeners.delete(cb);
  }

  private emitQueueState(): void {
    const state = {
      activeThreadId: this.activeThreadId,
      queuedThreadIds: this.queue.map((item) => item.threadId),
    };
    for (const cb of this.queueListeners) {
      cb(state);
    }
  }

  getQueueState(): { activeThreadId: string | null; queuedThreadIds: string[] } {
    return {
      activeThreadId: this.activeThreadId,
      queuedThreadIds: this.queue.map((item) => item.threadId),
    };
  }

  enqueueTurn(
    threadId: string,
    priority: TurnPriority,
    run: () => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ threadId, priority, run, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority);
      this.emitQueueState();
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.activeThreadId !== null) return;
    const next = this.queue.shift();
    if (!next) return;

    this.activeThreadId = next.threadId;
    this.emitQueueState();

    try {
      await next.run();
      next.resolve();
    } catch (err) {
      next.reject(err);
    } finally {
      this.activeThreadId = null;
      this.emitQueueState();
      void this.drainQueue();
    }
  }

  async probeVram(): Promise<VramStatus> {
    const loadedModels = await this.client.listRunningModels();
    const now = Date.now();
    if (this.cachedGpuSample && now - this.cachedGpuSample.at < 2000) {
      return {
        totalMb: this.cachedGpuSample.totalMb,
        freeMb: this.cachedGpuSample.freeMb,
        loadedModels,
      };
    }

    let totalMb = 0;
    let freeMb = 0;
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'],
        { timeout: 1500 },
      );
      const firstLine = stdout.trim().split(/\r?\n/)[0];
      if (firstLine) {
        const [tStr, fStr] = firstLine.split(',').map((s) => s.trim());
        totalMb = Number(tStr) || 0;
        freeMb = Number(fStr) || 0;
      }
    } catch {
      // Non-NVIDIA or nvidia-smi unavailable
    }

    this.cachedGpuSample = { at: now, totalMb, freeMb };
    return { totalMb, freeMb, loadedModels };
  }

  resolveRoleOptions(params: {
    role: 'fast' | 'main';
    fastModel: string;
    mainModel: string;
    effort: EffortLevel;
    settings: AppSettings;
    modelInfo?: OllamaModelInfo;
  }): RoleCallOptions {
    const profile = getEffortProfile(params.effort);
    const sameModel = params.fastModel === params.mainModel;
    const supportsThink = params.modelInfo?.capabilities.thinking ?? true;
    const maxCtx = params.modelInfo?.contextLength ?? profile.numCtx;

    if (params.role === 'fast') {
      const pinCpu =
        !sameModel &&
        (params.settings.pinFastToCpu ||
          params.settings.vramScheduleMode === 'cpu-pin-fast');

      // When Fast and Main share the same model, keep num_ctx identical so Ollama
      // never evicts/reloads the weights or invalidates KV cache between stages.
      const fastNumCtx = sameModel
        ? Math.min(profile.numCtx, maxCtx)
        : Math.min(6144, maxCtx);

      return {
        model: params.fastModel,
        think: supportsThink ? false : undefined,
        keepAlive: -1,
        options: {
          num_ctx: fastNumCtx,
          temperature: 0.1,
          top_p: 0.9,
          repeat_penalty: 1.08,
          num_batch: 512,
          num_predict: 512,
          ...(pinCpu ? { num_gpu: 0 } : {}),
        },
      };
    }

    const sampling = inferModelSamplingProfile(
      params.mainModel,
      params.modelInfo,
      profile.mainThink || params.effort === 'xhigh',
      profile.temperature,
    );
    const effectiveThink =
      params.effort === 'low' ? false : sampling.allowThink;

    return {
      model: params.mainModel,
      think: supportsThink ? effectiveThink : undefined,
      keepAlive: -1,
      options: {
        num_ctx: Math.min(profile.numCtx, maxCtx),
        temperature: sampling.temperature,
        top_p: sampling.top_p,
        min_p: sampling.min_p,
        repeat_penalty: sampling.repeat_penalty,
        ...(sampling.presence_penalty !== undefined
          ? { presence_penalty: sampling.presence_penalty }
          : {}),
        num_batch: sampling.num_batch,
        num_predict: profile.numPredict,
      },
    };
  }
}
