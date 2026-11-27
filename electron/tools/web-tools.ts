import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface ObscuraLookupParams {
  url?: string;
  query?: string;
  obscuraPath?: string;
  timeoutSec?: number;
  signal?: AbortSignal;
}

export interface ObscuraLookupResult {
  output: string;
  isError?: boolean;
}

export function getBundledObscuraCandidates(): string[] {
  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'obscura.exe' : 'obscura';
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

export function isBundledObscuraPath(binaryPath: string | null): boolean {
  if (!binaryPath) return false;
  const resolved = resolve(binaryPath);
  return getBundledObscuraCandidates().some((c) => resolve(c) === resolved);
}

export function getObscuraStorageDir(): string {
  const dir = join(homedir(), '.smolcode', 'obscura');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveObscuraBinary(configuredPath?: string): string | null {
  const trimmed = configuredPath?.trim();
  if (trimmed && existsSync(trimmed)) return trimmed;

  // Prefer the Obscura browser bundled inside the SmolCode project / app resources
  for (const bundled of getBundledObscuraCandidates()) {
    if (existsSync(bundled)) return bundled;
  }

  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'obscura.exe' : 'obscura';
  const candidates = isWin
    ? [
        'C:\\Tools\\obscura\\obscura.exe',
        join(homedir(), '.smolcode', 'bin', 'obscura.exe'),
      ]
    : [
        '/usr/local/bin/obscura',
        join(homedir(), '.smolcode', 'bin', 'obscura'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const pathDirs = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean);
  for (const dir of pathDirs) {
    const full = join(dir, exeName);
    if (existsSync(full)) return full;
  }

  return null;
}

function validateHttpUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}". Only http/https allowed.`);
  }
  return parsed;
}

export function extractSearchResultUrls(rawLinksOutput: string, maxUrls = 3): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const lines = rawLinksOutput.split(/\r?\n/);

  for (const line of lines) {
    const matches = line.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
    for (let raw of matches) {
      try {
        const u = new URL(raw);
        if (u.hostname.includes('duckduckgo.com')) {
          const uddg = u.searchParams.get('uddg');
          if (!uddg) continue;
          raw = decodeURIComponent(uddg);
        }
        const clean = new URL(raw);
        if (
          clean.hostname.includes('duckduckgo.com') ||
          clean.hostname.includes('w3.org') ||
          seen.has(clean.toString())
        ) {
          continue;
        }
        seen.add(clean.toString());
        urls.push(clean.toString());
        if (urls.length >= maxUrls) return urls;
      } catch {
        // Ignore malformed URLs
      }
    }
  }
  return urls;
}

async function execObscura(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const storageDir = getObscuraStorageDir();
  const fullArgs = ['--storage-dir', storageDir, ...args];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binaryPath, fullArgs, {
      cwd: dirname(resolve(binaryPath)),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const killChild = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Ignore exit race
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      reject(new Error('Obscura lookup aborted.'));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      reject(new Error(`Obscura lookup timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 256_000) {
        stdout += String(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 32_000) {
        stderr += String(chunk);
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

function clipDigest(text: string, maxChars = 6000): string {
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n\n...[truncated ${cleaned.length - maxChars} chars]`;
}

export async function runObscuraLookup(
  params: ObscuraLookupParams,
): Promise<ObscuraLookupResult> {
  const binary = resolveObscuraBinary(params.obscuraPath);
  if (!binary) {
    return {
      output: 'Bundled Obscura browser binary was not found.',
      isError: true,
    };
  }

  const timeoutSec = Math.max(5, Math.min(35, params.timeoutSec ?? 20));
  const timeoutMs = (timeoutSec + 5) * 1000;

  try {
    if (params.url?.trim()) {
      const validUrl = validateHttpUrl(params.url);
      let res = await execObscura(
        binary,
        ['fetch', validUrl.toString(), '--dump', 'markdown', '--timeout', String(timeoutSec), '--quiet'],
        timeoutMs,
        params.signal,
      );
      if (!res.stdout.trim()) {
        res = await execObscura(
          binary,
          ['fetch', validUrl.toString(), '--dump', 'text', '--stealth', '--timeout', String(timeoutSec), '--quiet'],
          timeoutMs,
          params.signal,
        );
      }
      const body = clipDigest(res.stdout);
      if (!body) {
        return {
          output: `Obscura fetched ${validUrl.toString()} with empty body.${res.stderr ? ` (${res.stderr.trim().slice(0, 200)})` : ''}`,
          isError: res.code !== 0,
        };
      }
      return {
        output: `Source: ${validUrl.toString()}\n\n${body}`,
      };
    }

    const query = params.query?.trim();
    if (!query) {
      return {
        output: 'web_lookup requires either "url" or "query".',
        isError: true,
      };
    }

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const searchRes = await execObscura(
      binary,
      ['fetch', searchUrl, '--dump', 'links', '--stealth', '--timeout', String(timeoutSec), '--quiet'],
      timeoutMs,
      params.signal,
    );

    const urls = extractSearchResultUrls(searchRes.stdout, 2);
    if (urls.length === 0) {
      const mdRes = await execObscura(
        binary,
        ['fetch', searchUrl, '--dump', 'markdown', '--stealth', '--timeout', String(timeoutSec), '--quiet'],
        timeoutMs,
        params.signal,
      );
      const fallback = clipDigest(mdRes.stdout, 5000);
      return {
        output: fallback
          ? `Search results for "${query}":\n\n${fallback}`
          : `No readable search results found for "${query}".`,
      };
    }

    const sections: string[] = [`Search query: "${query}"`, `Top URLs:\n${urls.map((u) => `- ${u}`).join('\n')}`];
    for (const targetUrl of urls) {
      try {
        const page = await execObscura(
          binary,
          ['fetch', targetUrl, '--dump', 'markdown', '--timeout', String(timeoutSec), '--quiet'],
          timeoutMs,
          params.signal,
        );
        const excerpt = clipDigest(page.stdout, 2600);
        if (excerpt) {
          sections.push(`--- ${targetUrl} ---\n${excerpt}`);
        }
      } catch {
        // Skip failed secondary page fetch
      }
    }

    return { output: clipDigest(sections.join('\n\n'), 6400) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      output: `Obscura lookup failed: ${msg}`,
      isError: true,
    };
  }
}
