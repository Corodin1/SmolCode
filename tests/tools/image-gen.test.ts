import { createServer, type Server } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectLocalImageBackends,
  isOllamaImageModelName,
  parseImageSize,
  resolveSdCppBinary,
  runLocalImageGeneration,
} from '../../electron/tools/image-gen';
import { buildToolListForThread } from '../../electron/tools/tool-registry';
import { DEFAULT_APP_SETTINGS } from '../../src/state/defaults';

const servers: Server[] = [];
const generatedFilesToClean: string[] = [];

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW0cAAAAASUVORK5CYII=';

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop();
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
  while (generatedFilesToClean.length > 0) {
    const f = generatedFilesToClean.pop();
    if (f && existsSync(f)) {
      rmSync(f, { force: true });
    }
  }
});

async function startLoopbackServer(
  handler: (url: string, method: string, body: string) => { status: number; json: unknown },
): Promise<string> {
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const result = handler(req.url ?? '/', req.method ?? 'GET', bodyStr);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.json));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  servers.push(srv);
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind server');
  return `http://127.0.0.1:${addr.port}`;
}

describe('Local Image Generation & Tool Scoping', () => {
  it('parses preset sizes, clamps custom dimensions to multiples of 64, and detects Ollama image model names', () => {
    expect(parseImageSize('1024x576')).toEqual({ width: 1024, height: 576 });
    expect(parseImageSize('700x500')).toEqual({ width: 704, height: 512 });
    expect(parseImageSize('9999x100')).toEqual({ width: 1536, height: 256 });

    expect(isOllamaImageModelName('x/z-image-turbo')).toBe(true);
    expect(isOllamaImageModelName('x/flux2-klein')).toBe(true);
    expect(isOllamaImageModelName('qwen3.5:9b')).toBe(false);
  });

  it('scopes generate_image tool to Build mode when image-gen skill or image prompt is present', () => {
    const planTools = buildToolListForThread('plan', [], {
      userPrompt: 'generate an image of a cat',
      hasImageGenSkill: true,
    });
    expect(planTools.some((t) => t.function.name === 'generate_image')).toBe(false);

    const buildWithSkill = buildToolListForThread('build', [], {
      userPrompt: 'cyberpunk alley',
      hasImageGenSkill: true,
    });
    expect(buildWithSkill.some((t) => t.function.name === 'generate_image')).toBe(true);

    const buildWithPrompt = buildToolListForThread('build', [], {
      userPrompt: 'create a clean vector logo for my app',
    });
    expect(buildWithPrompt.some((t) => t.function.name === 'generate_image')).toBe(true);

    const buildCodePrompt = buildToolListForThread('build', [], {
      userPrompt: 'refactor parser.ts to use a loop',
    });
    expect(buildCodePrompt.some((t) => t.function.name === 'generate_image')).toBe(false);
  });

  it('generates an image via Ollama /v1/images/generations and invokes VRAM unload callback', async () => {
    const baseUrl = await startLoopbackServer((url, _method, body) => {
      if (url === '/api/tags') {
        return {
          status: 200,
          json: { models: [{ name: 'qwen3.5:9b' }, { name: 'x/flux2-klein' }] },
        };
      }
      if (url === '/v1/images/generations') {
        const parsed = JSON.parse(body) as { model?: string; size?: string };
        expect(parsed.model).toBe('x/flux2-klein');
        expect(parsed.size).toBe('1024x576');
        return {
          status: 200,
          json: { data: [{ b64_json: TINY_PNG_BASE64 }] },
        };
      }
      return { status: 404, json: { error: 'not found' } };
    });

    const beforeGenerate = vi.fn(async () => {});
    const res = await runLocalImageGeneration({
      threadId: 'test-img-thread',
      turnId: 'test-turn-1',
      prompt: 'misty pine forest at dawn',
      size: '1024x576',
      seed: 42,
      settings: {
        ...DEFAULT_APP_SETTINGS,
        ollamaBaseUrl: baseUrl,
        imageGenProvider: 'auto',
        ollamaImageModel: 'x/flux2-klein',
      },
      beforeGenerate,
    });

    expect(res.ok).toBe(true);
    expect(res.image).toBeDefined();
    if (res.image) generatedFilesToClean.push(res.image.filePath);
    expect(beforeGenerate).toHaveBeenCalledWith('ollama', 'x/flux2-klein');
    expect(res.image?.backend).toBe('ollama');
    expect(res.image?.width).toBe(1024);
    expect(res.image?.height).toBe(576);
    expect(res.image?.seed).toBe(42);
    expect(res.image?.dataUrl).toContain('data:image/png;base64,');
    expect(existsSync(res.image!.filePath)).toBe(true);
  });

  it('falls back to Ollama /api/generate when /v1/images/generations returns 404', async () => {
    const baseUrl = await startLoopbackServer((url) => {
      if (url === '/api/tags') {
        return { status: 200, json: { models: [{ name: 'x/z-image-turbo' }] } };
      }
      if (url === '/v1/images/generations') {
        return { status: 404, json: { error: 'route missing' } };
      }
      if (url === '/api/generate') {
        return { status: 200, json: { image: TINY_PNG_BASE64 } };
      }
      return { status: 404, json: {} };
    });

    const res = await runLocalImageGeneration({
      threadId: 'test-img-fallback',
      turnId: 'test-turn-2',
      prompt: 'isometric pixel cat',
      settings: {
        ...DEFAULT_APP_SETTINGS,
        ollamaBaseUrl: baseUrl,
        imageGenProvider: 'ollama',
        ollamaImageModel: 'x/z-image-turbo',
      },
    });

    expect(res.ok).toBe(true);
    if (res.image) generatedFilesToClean.push(res.image.filePath);
    expect(res.image?.model).toBe('x/z-image-turbo');
  });

  it('detects the bundled sd-cli engine inside the project automatically', async () => {
    const bin = resolveSdCppBinary();
    expect(bin).toBeTruthy();
    expect(existsSync(bin!)).toBe(true);

    const status = await detectLocalImageBackends({
      ...DEFAULT_APP_SETTINGS,
      ollamaBaseUrl: 'http://127.0.0.1:1',
    });
    expect(status.sdCppPath).toBe(bin);
    expect(status.sdCppBundled).toBe(true);
  });

  it('supports Automatic1111 backend and returns actionable diagnostic when no local model is ready', async () => {
    const a1111Url = await startLoopbackServer((url) => {
      if (url === '/sdapi/v1/sd-models') {
        return { status: 200, json: [{ title: 'dreamshaper.safetensors' }] };
      }
      if (url === '/sdapi/v1/txt2img') {
        return { status: 200, json: { images: [TINY_PNG_BASE64] } };
      }
      return { status: 404, json: {} };
    });

    const status = await detectLocalImageBackends({
      ...DEFAULT_APP_SETTINGS,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      imageGenProvider: 'a1111',
      imageGenLocalUrl: a1111Url,
    });
    expect(status.a1111Up).toBe(true);

    const a1111Res = await runLocalImageGeneration({
      threadId: 'test-img-a1111',
      turnId: 'test-turn-3',
      prompt: 'minimalist geometric wallpaper',
      settings: {
        ...DEFAULT_APP_SETTINGS,
        ollamaBaseUrl: 'http://127.0.0.1:1',
        imageGenProvider: 'a1111',
        imageGenLocalUrl: a1111Url,
      },
    });
    expect(a1111Res.ok).toBe(true);
    if (a1111Res.image) generatedFilesToClean.push(a1111Res.image.filePath);
    expect(a1111Res.image?.backend).toBe('a1111');

    const noneRes = await runLocalImageGeneration({
      threadId: 'test-img-none',
      turnId: 'test-turn-4',
      prompt: 'neon city',
      settings: {
        ...DEFAULT_APP_SETTINGS,
        ollamaBaseUrl: 'http://127.0.0.1:1',
        imageGenProvider: 'auto',
        sdCppPath: '',
        sdCppModelPath: '',
      },
    });
    expect(noneRes.ok).toBe(false);
    expect(noneRes.error).toMatch(/Bundled engine.*no local model file|No local image generation/i);
  });
});
