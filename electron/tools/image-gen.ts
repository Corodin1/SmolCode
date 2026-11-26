import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  AppSettings,
  GeneratedImageRecord,
  ImageGenProvider,
  ImageModelDownloadProgress,
  ImageModelPresetId,
  LocalImageBackendStatus,
} from '../../src/shared/types';

const execFileAsync = promisify(execFile);

export type ConcreteImageBackend = Exclude<ImageGenProvider, 'auto'>;

export interface ImageGenerationRequest {
  threadId: string;
  turnId: string;
  prompt: string;
  negativePrompt?: string;
  size?: string;
  steps?: number;
  seed?: number;
  settings: AppSettings;
  signal?: AbortSignal;
  beforeGenerate?: (backend: ConcreteImageBackend, targetModel: string) => Promise<void>;
}

export interface ImageGenerationResult {
  ok: boolean;
  image?: GeneratedImageRecord;
  error?: string;
}

const PRESET_SIZES: Record<string, { width: number; height: number }> = {
  '512x512': { width: 512, height: 512 },
  '768x768': { width: 768, height: 768 },
  '1024x1024': { width: 1024, height: 1024 },
  '1024x576': { width: 1024, height: 576 },
  '576x1024': { width: 576, height: 1024 },
};

export function parseImageSize(size?: string): { width: number; height: number } {
  const cleaned = (size ?? '1024x1024').trim().toLowerCase();
  if (PRESET_SIZES[cleaned]) return PRESET_SIZES[cleaned];
  const m = cleaned.match(/^(\d{3,4})\s*[x×]\s*(\d{3,4})$/);
  if (!m) return { width: 1024, height: 1024 };
  const clamp64 = (n: number) =>
    Math.min(1536, Math.max(256, Math.round(n / 64) * 64));
  return {
    width: clamp64(Number(m[1])),
    height: clamp64(Number(m[2])),
  };
}

export function isOllamaImageModelName(name: string): boolean {
  return /(?:^|\/)(?:z-image|flux2?-|sdxl|sd\d|stable-diffusion|image-gen|klein)/i.test(
    name.trim(),
  );
}

export function resolveImageStorageDir(threadId: string): string {
  const safeId = threadId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  const dir = join(homedir(), '.smolcode', 'generated-images', safeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getGeneratedImagesRoot(): string {
  return join(homedir(), '.smolcode', 'generated-images');
}

export function getBundledImageModelsDir(): string {
  const dir = join(homedir(), '.smolcode', 'models', 'image');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface ImageModelPreset {
  id: ImageModelPresetId;
  label: string;
  fileName: string;
  url: string;
  sizeLabel: string;
  description: string;
}

export const IMAGE_MODEL_PRESETS: Record<ImageModelPresetId, ImageModelPreset> = {
  'dreamshaper-8': {
    id: 'dreamshaper-8',
    label: 'DreamShaper 8 (Pruned)',
    fileName: 'DreamShaper_8_pruned.safetensors',
    url: 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors',
    sizeLabel: '2.0 GB',
    description: 'Fast single-file SD 1.5 model; fits comfortably in 8 GB VRAM.',
  },
  'sdxl-turbo': {
    id: 'sdxl-turbo',
    label: 'SDXL Turbo 1.0 (FP16)',
    fileName: 'sd_xl_turbo_1.0_fp16.safetensors',
    url: 'https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors',
    sizeLabel: '6.5 GB',
    description: '4-step ultra-fast 1024px single-file SDXL model.',
  },
};

function getBundledEngineCandidates(): string[] {
  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'sd-cli.exe' : 'sd-cli';
  const targetDir = `${process.platform}-${process.arch}`;
  const candidates: string[] = [];

  const resPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resPath) {
    candidates.push(join(resPath, 'bin', targetDir, exeName));
    candidates.push(join(resPath, 'bin', exeName));
  }
  candidates.push(
    join(process.cwd(), 'resources', 'bin', targetDir, exeName),
    resolve(__dirname, '../../resources/bin', targetDir, exeName),
    resolve(__dirname, '../../../resources/bin', targetDir, exeName),
  );
  return candidates;
}

export function isBundledSdCppPath(binaryPath: string | null): boolean {
  if (!binaryPath) return false;
  const resolved = resolve(binaryPath);
  return getBundledEngineCandidates().some((c) => resolve(c) === resolved);
}

export function listLocalImageModels(): string[] {
  const dirs = [
    getBundledImageModelsDir(),
    join(process.cwd(), 'resources', 'models', 'image'),
  ];
  const resPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resPath) {
    dirs.push(join(resPath, 'models', 'image'));
  }

  const exts = new Set(['.safetensors', '.gguf', '.ckpt']);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!exts.has(extname(entry.name).toLowerCase())) continue;
        const abs = resolve(dir, entry.name);
        if (!seen.has(abs)) {
          seen.add(abs);
          found.push(abs);
        }
      }
    } catch {
      // Ignore unreadable model directories
    }
  }
  return found.sort();
}

export function resolveSdCppBinary(configuredPath?: string): string | null {
  const trimmed = configuredPath?.trim();
  if (trimmed && existsSync(trimmed)) return trimmed;

  // Prefer the engine bundled inside the SmolCode project / app resources
  for (const bundled of getBundledEngineCandidates()) {
    if (existsSync(bundled)) return bundled;
  }

  const isWin = process.platform === 'win32';
  const candidates = [
    ...(isWin
      ? [
          'C:\\Tools\\sd\\sd-cli.exe',
          'C:\\Tools\\sd\\sd.exe',
          'C:\\Tools\\stable-diffusion.cpp\\sd-cli.exe',
          join(homedir(), '.smolcode', 'bin', 'sd-cli.exe'),
          join(homedir(), '.smolcode', 'bin', 'sd.exe'),
        ]
      : [
          '/usr/local/bin/sd-cli',
          '/usr/local/bin/sd',
          join(homedir(), '.smolcode', 'bin', 'sd-cli'),
        ]),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  const pathDirs = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean);
  const exeNames = isWin ? ['sd-cli.exe', 'sd.exe'] : ['sd-cli', 'sd'];
  for (const dir of pathDirs) {
    for (const exe of exeNames) {
      const full = join(dir, exe);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function splitCliArgs(raw: string): string[] {
  const out: string[] = [];
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of raw.matchAll(rx)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

async function probeJsonOk(url: string, timeoutMs = 900): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  return (raw?.trim() || fallback).replace(/\/+$/, '');
}

export async function detectLocalImageBackends(
  settings: AppSettings,
): Promise<LocalImageBackendStatus> {
  const sdCppPath = resolveSdCppBinary(settings.sdCppPath);
  const ollamaUrl = normalizeBaseUrl(settings.ollamaBaseUrl, 'http://127.0.0.1:11434');
  const localUrl = normalizeBaseUrl(settings.imageGenLocalUrl, 'http://127.0.0.1:8188');

  const comfyCandidate =
    settings.imageGenProvider === 'comfyui' ? localUrl : 'http://127.0.0.1:8188';
  const a1111Candidate =
    settings.imageGenProvider === 'a1111' ? localUrl : 'http://127.0.0.1:7860';

  const [ollamaTags, comfyStats, a1111Models] = await Promise.all([
    probeJsonOk(`${ollamaUrl}/api/tags`, 1100),
    probeJsonOk(`${comfyCandidate}/system_stats`, 900),
    probeJsonOk(`${a1111Candidate}/sdapi/v1/sd-models`, 900),
  ]);

  const tagList =
    ollamaTags &&
    typeof ollamaTags === 'object' &&
    Array.isArray((ollamaTags as { models?: unknown[] }).models)
      ? ((ollamaTags as { models: Array<{ name?: string }> }).models ?? [])
      : [];

  const ollamaImageModels = tagList
    .map((m) => String(m.name ?? ''))
    .filter((name) => Boolean(name) && isOllamaImageModelName(name));

  return {
    sdCppPath,
    sdCppBundled: isBundledSdCppPath(sdCppPath),
    localModelFiles: listLocalImageModels(),
    comfyUiUp: Boolean(comfyStats),
    a1111Up: Array.isArray(a1111Models),
    ollamaImageModels,
  };
}

export async function downloadImageModelPreset(
  presetId: ImageModelPresetId,
  onProgress?: (progress: ImageModelDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; savedPath?: string; error?: string }> {
  const preset = IMAGE_MODEL_PRESETS[presetId];
  if (!preset) {
    return { ok: false, error: `Unknown image model preset: ${presetId}` };
  }
  const dir = getBundledImageModelsDir();
  const destPath = join(dir, preset.fileName);
  if (existsSync(destPath)) {
    onProgress?.({
      presetId,
      fileName: preset.fileName,
      receivedBytes: 1,
      totalBytes: 1,
      status: 'done',
      savedPath: destPath,
    });
    return { ok: true, savedPath: destPath };
  }

  const partPath = `${destPath}.part`;
  try {
    const res = await fetch(preset.url, { redirect: 'follow', signal });
    if (!res.ok || !res.body) {
      const msg = `Download failed (${res.status} ${res.statusText})`;
      onProgress?.({
        presetId,
        fileName: preset.fileName,
        receivedBytes: 0,
        totalBytes: 0,
        status: 'error',
        error: msg,
      });
      return { ok: false, error: msg };
    }

    const totalBytes = Number(res.headers.get('content-length') ?? 0) || 0;
    let receivedBytes = 0;
    let lastEmit = 0;

    const ws = createWriteStream(partPath);
    const reader = res.body.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.byteLength;
          if (!ws.write(Buffer.from(value))) {
            await new Promise<void>((resolveDrain) => ws.once('drain', resolveDrain));
          }
          const now = Date.now();
          if (now - lastEmit >= 180) {
            lastEmit = now;
            onProgress?.({
              presetId,
              fileName: preset.fileName,
              receivedBytes,
              totalBytes,
              status: 'downloading',
            });
          }
        }
      }
      await new Promise<void>((resolveEnd, rejectEnd) => {
        ws.end(() => resolveEnd());
        ws.on('error', rejectEnd);
      });
    } catch (err) {
      ws.destroy();
      if (existsSync(partPath)) rmSync(partPath, { force: true });
      throw err;
    }

    renameSync(partPath, destPath);
    onProgress?.({
      presetId,
      fileName: preset.fileName,
      receivedBytes,
      totalBytes: totalBytes || receivedBytes,
      status: 'done',
      savedPath: destPath,
    });
    return { ok: true, savedPath: destPath };
  } catch (err) {
    if (existsSync(partPath)) rmSync(partPath, { force: true });
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.({
      presetId,
      fileName: preset.fileName,
      receivedBytes: 0,
      totalBytes: 0,
      status: 'error',
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

function extractBase64Payload(raw: string): Buffer {
  const cleaned = raw.includes(',') ? raw.split(',')[1] : raw;
  return Buffer.from(cleaned.trim(), 'base64');
}

async function generateViaOllama(params: {
  baseUrl: string;
  model: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const sizeStr = `${params.width}x${params.height}`;
  const v1Res = await fetch(`${params.baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      n: 1,
      size: sizeStr,
      response_format: 'b64_json',
    }),
    signal: params.signal,
  });

  if (v1Res.ok) {
    const payload = (await v1Res.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const first = payload.data?.[0];
    if (first?.b64_json) {
      return extractBase64Payload(first.b64_json);
    }
    if (first?.url) {
      const imgRes = await fetch(first.url, { signal: params.signal });
      if (imgRes.ok) {
        return Buffer.from(await imgRes.arrayBuffer());
      }
    }
    throw new Error(`Ollama /v1/images/generations returned no image data for "${params.model}".`);
  }

  if (v1Res.status !== 404 && v1Res.status !== 405) {
    const errText = await v1Res.text().catch(() => '');
    throw new Error(`Ollama image generation failed (${v1Res.status}): ${errText || v1Res.statusText}`);
  }

  // Fallback for Ollama builds exposing native /api/generate image fields
  const genRes = await fetch(`${params.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      stream: false,
      width: params.width,
      height: params.height,
      steps: params.steps,
      seed: params.seed,
    }),
    signal: params.signal,
  });
  if (!genRes.ok) {
    const errText = await genRes.text().catch(() => '');
    throw new Error(`Ollama /api/generate image failed (${genRes.status}): ${errText || genRes.statusText}`);
  }
  const genData = (await genRes.json()) as {
    image?: string;
    images?: string[];
  };
  const b64 = genData.image ?? genData.images?.[0];
  if (!b64) {
    throw new Error(`Ollama /api/generate returned no image bytes for "${params.model}".`);
  }
  return extractBase64Payload(b64);
}

async function generateViaSdCpp(params: {
  binary: string;
  modelPath: string;
  vaePath?: string;
  extraArgs?: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  outPath: string;
  signal?: AbortSignal;
}): Promise<Buffer> {
  if (!params.modelPath || !existsSync(params.modelPath)) {
    throw new Error('sd.cpp model path is not configured or missing on disk.');
  }
  const isTurboModel = /turbo|klein|lightning/i.test(basename(params.modelPath));
  const extraTokens = params.extraArgs ? splitCliArgs(params.extraArgs) : [];
  const hasCfgScale = extraTokens.some((a) => a === '--cfg-scale');
  const args = [
    '-m',
    params.modelPath,
    ...(params.vaePath && existsSync(params.vaePath) ? ['--vae', params.vaePath] : []),
    '-p',
    params.prompt,
    ...(params.negativePrompt ? ['-n', params.negativePrompt] : []),
    '-W',
    String(params.width),
    '-H',
    String(params.height),
    '--steps',
    String(params.steps),
    ...(!hasCfgScale && isTurboModel ? ['--cfg-scale', '1.0'] : []),
    '-s',
    String(params.seed),
    '-o',
    params.outPath,
    ...extraTokens,
  ];

  await execFileAsync(params.binary, args, {
    cwd: dirname(params.binary),
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
    signal: params.signal,
  });

  if (!existsSync(params.outPath)) {
    throw new Error(`sd.cpp completed without writing output file: ${params.outPath}`);
  }
  return readFileSync(params.outPath);
}

async function generateViaComfyUi(params: {
  baseUrl: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  preferredCheckpoint?: string;
  signal?: AbortSignal;
}): Promise<{ buffer: Buffer; model: string }> {
  const infoRes = await fetch(`${params.baseUrl}/object_info/CheckpointLoaderSimple`, {
    signal: params.signal,
  });
  if (!infoRes.ok) {
    throw new Error(`ComfyUI unreachable or missing CheckpointLoaderSimple (${infoRes.status}).`);
  }
  const infoData = (await infoRes.json()) as {
    CheckpointLoaderSimple?: {
      input?: { required?: { ckpt_name?: [string[]] } };
    };
  };
  const ckpts = infoData.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  const preferredBase = params.preferredCheckpoint ? basename(params.preferredCheckpoint) : '';
  const ckptName =
    (preferredBase && ckpts.includes(preferredBase) ? preferredBase : ckpts[0]) || '';
  if (!ckptName) {
    throw new Error('ComfyUI is running, but no checkpoint models were found in checkpoints/.');
  }

  const clientId = randomUUID();
  const workflow = {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: params.seed,
        steps: params.steps,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckptName } },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['4', 1] } },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.negativePrompt || 'blurry, low quality, deformed', clip: ['4', 1] },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'smolcode', images: ['8', 0] },
    },
  };

  const queueRes = await fetch(`${params.baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: params.signal,
  });
  if (!queueRes.ok) {
    const errText = await queueRes.text().catch(() => '');
    throw new Error(`ComfyUI /prompt failed (${queueRes.status}): ${errText}`);
  }
  const { prompt_id: promptId } = (await queueRes.json()) as { prompt_id?: string };
  if (!promptId) throw new Error('ComfyUI did not return prompt_id.');

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error('Image generation aborted');
    await new Promise((r) => setTimeout(r, 450));
    const histRes = await fetch(`${params.baseUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: params.signal,
    });
    if (!histRes.ok) continue;
    const hist = (await histRes.json()) as Record<
      string,
      {
        outputs?: Record<
          string,
          { images?: Array<{ filename: string; subfolder?: string; type?: string }> }
        >;
      }
    >;
    const entry = hist[promptId];
    if (!entry?.outputs) continue;
    for (const nodeOut of Object.values(entry.outputs)) {
      const img = nodeOut.images?.[0];
      if (!img?.filename) continue;
      const qs = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder ?? '',
        type: img.type ?? 'output',
      });
      const viewRes = await fetch(`${params.baseUrl}/view?${qs.toString()}`, {
        signal: params.signal,
      });
      if (!viewRes.ok) {
        throw new Error(`ComfyUI /view failed (${viewRes.status})`);
      }
      return {
        buffer: Buffer.from(await viewRes.arrayBuffer()),
        model: ckptName,
      };
    }
  }
  throw new Error('ComfyUI image generation timed out.');
}

async function generateViaA1111(params: {
  baseUrl: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const res = await fetch(`${params.baseUrl}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: params.prompt,
      negative_prompt: params.negativePrompt ?? '',
      width: params.width,
      height: params.height,
      steps: params.steps,
      seed: params.seed,
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Automatic1111 /sdapi/v1/txt2img failed (${res.status}): ${errText}`);
  }
  const data = (await res.json()) as { images?: string[] };
  const first = data.images?.[0];
  if (!first) throw new Error('Automatic1111 returned no generated images.');
  return extractBase64Payload(first);
}

export async function runLocalImageGeneration(
  req: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const prompt = req.prompt.trim();
  if (!prompt) {
    return { ok: false, error: 'Image prompt cannot be empty.' };
  }

  const startedAt = Date.now();
  const { width, height } = parseImageSize(req.size ?? req.settings.imageGenDefaultSize);
  const seed =
    typeof req.seed === 'number' && Number.isFinite(req.seed) && req.seed >= 0
      ? Math.floor(req.seed)
      : Math.floor(Math.random() * 2_147_483_647);
  const id = randomUUID();
  const outPath = join(resolveImageStorageDir(req.threadId), `${id}.png`);
  const provider = req.settings.imageGenProvider ?? 'auto';
  const ollamaUrl = normalizeBaseUrl(req.settings.ollamaBaseUrl, 'http://127.0.0.1:11434');
  const status = await detectLocalImageBackends(req.settings);

  const resolvedSdModelPath =
    (req.settings.sdCppModelPath?.trim() && existsSync(req.settings.sdCppModelPath.trim())
      ? req.settings.sdCppModelPath.trim()
      : status.localModelFiles[0]) || '';

  const pickBackend = (): { backend: ConcreteImageBackend; model: string } | null => {
    const configuredOllamaModel = req.settings.ollamaImageModel?.trim();
    const matchedOllamaModel =
      (configuredOllamaModel &&
        status.ollamaImageModels.find((m) => m === configuredOllamaModel)) ||
      status.ollamaImageModels[0] ||
      '';

    if (provider === 'ollama') {
      const model = configuredOllamaModel || matchedOllamaModel || 'x/flux2-klein';
      return { backend: 'ollama', model };
    }
    if (provider === 'sd-cpp') {
      return status.sdCppPath
        ? { backend: 'sd-cpp', model: basename(resolvedSdModelPath || 'sd-cpp') }
        : null;
    }
    if (provider === 'comfyui') {
      return status.comfyUiUp ? { backend: 'comfyui', model: 'comfyui' } : null;
    }
    if (provider === 'a1111') {
      return status.a1111Up ? { backend: 'a1111', model: 'a1111' } : null;
    }

    // Auto cascade: bundled sd-cpp engine with a local model, Ollama image model, ComfyUI, A1111
    if (status.sdCppPath && resolvedSdModelPath) {
      return { backend: 'sd-cpp', model: basename(resolvedSdModelPath) };
    }
    if (matchedOllamaModel) {
      return { backend: 'ollama', model: matchedOllamaModel };
    }
    if (status.comfyUiUp) {
      return { backend: 'comfyui', model: 'comfyui' };
    }
    if (status.a1111Up) {
      return { backend: 'a1111', model: 'a1111' };
    }
    return null;
  };

  const chosen = pickBackend();
  if (!chosen) {
    const engineMsg = status.sdCppPath
      ? `Bundled engine (${basename(status.sdCppPath)}) is ready, but no local model file was found yet.`
      : 'No local image generation engine or server was found.';
    return {
      ok: false,
      error: [
        engineMsg,
        'Open Settings -> Models & Inference -> Local Image Generation to download a starter model with 1 click (or browse for an existing .safetensors / .gguf checkpoint).',
      ].join(' '),
    };
  }

  const defaultSteps =
    /turbo/i.test(chosen.model)
      ? 4
      : chosen.backend === 'ollama' || /klein|lightning/i.test(chosen.model)
        ? 8
        : 20;
  const steps =
    typeof req.steps === 'number' && Number.isFinite(req.steps)
      ? Math.min(60, Math.max(1, Math.round(req.steps)))
      : defaultSteps;

  try {
    if (req.settings.imageGenUnloadOllama !== false && req.beforeGenerate) {
      await req.beforeGenerate(chosen.backend, chosen.model);
    }

    let pngBuffer: Buffer;
    let resolvedModel = chosen.model;

    if (chosen.backend === 'ollama') {
      pngBuffer = await generateViaOllama({
        baseUrl: ollamaUrl,
        model: chosen.model,
        prompt,
        width,
        height,
        steps,
        seed,
        signal: req.signal,
      });
    } else if (chosen.backend === 'sd-cpp') {
      pngBuffer = await generateViaSdCpp({
        binary: status.sdCppPath!,
        modelPath: resolvedSdModelPath,
        vaePath: req.settings.sdCppVaePath,
        extraArgs: req.settings.sdCppExtraArgs,
        prompt,
        negativePrompt: req.negativePrompt,
        width,
        height,
        steps,
        seed,
        outPath,
        signal: req.signal,
      });
    } else if (chosen.backend === 'comfyui') {
      const comfyUrl = normalizeBaseUrl(
        provider === 'comfyui' ? req.settings.imageGenLocalUrl : undefined,
        'http://127.0.0.1:8188',
      );
      const res = await generateViaComfyUi({
        baseUrl: comfyUrl,
        prompt,
        negativePrompt: req.negativePrompt,
        width,
        height,
        steps,
        seed,
        preferredCheckpoint: req.settings.sdCppModelPath,
        signal: req.signal,
      });
      pngBuffer = res.buffer;
      resolvedModel = res.model;
    } else {
      const a1111Url = normalizeBaseUrl(
        provider === 'a1111' ? req.settings.imageGenLocalUrl : undefined,
        'http://127.0.0.1:7860',
      );
      pngBuffer = await generateViaA1111({
        baseUrl: a1111Url,
        prompt,
        negativePrompt: req.negativePrompt,
        width,
        height,
        steps,
        seed,
        signal: req.signal,
      });
    }

    writeFileSync(outPath, pngBuffer);
    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;

    return {
      ok: true,
      image: {
        id,
        threadId: req.threadId,
        turnId: req.turnId,
        prompt,
        ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
        filePath: outPath,
        dataUrl,
        width,
        height,
        steps,
        seed,
        model: resolvedModel,
        backend: chosen.backend,
        durationMs: Math.max(1, Date.now() - startedAt),
        createdAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
