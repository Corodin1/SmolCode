import { spawn } from 'node:child_process';
import type { ApprovalPolicy } from '../../src/shared/types';
import { digestCommandOutput } from '../intel/error-digest';

export const SAFE_READ_ONLY_PATTERNS = [
  /^(dir|ls|pwd|echo|cat|type|where|which|rg|find|findstr|tree|head|tail|wc|stat)\b/i,
  /^(node|npm|npx|python|python3|rustc|cargo|go)\s+(-v|--version|version)\b/i,
  /^npx\s+tsc\b.*--noEmit\b/i,
  /^npm\s+run\s+(typecheck|lint)\b/i,
  /^ruff\s+check\b/i,
  /^cargo\s+(check|clippy)\b/i,
];

export const SAFE_AUTO_TEST_PATTERNS = [
  ...SAFE_READ_ONLY_PATTERNS,
  /^npm\s+(test|run\s+test)\b/i,
  /^npx\s+(vitest|jest)\b/i,
  /^python\s+-m\s+(pytest|py_compile|unittest)\b/i,
  /^pytest\b/i,
  /^cargo\s+test\b/i,
];

export function commandNeedsApproval(
  command: string,
  policy: ApprovalPolicy,
  sessionApprovedCommands: Set<string>,
): 'allow' | 'deny' | 'ask' {
  const trimmed = command.trim();
  if (policy === 'full-access') return 'allow';
  if (policy === 'read-only') {
    const isSafeRead = SAFE_READ_ONLY_PATTERNS.some((rx) => rx.test(trimmed));
    return isSafeRead ? 'allow' : 'deny';
  }
  if (sessionApprovedCommands.has(trimmed)) return 'allow';
  const isSafeAuto = SAFE_AUTO_TEST_PATTERNS.some((rx) => rx.test(trimmed));
  return isSafeAuto ? 'allow' : 'ask';
}

function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        const safety = setTimeout(resolve, 1500);
        killer.once('close', () => {
          clearTimeout(safety);
          resolve();
        });
        killer.once('error', () => {
          clearTimeout(safety);
          resolve();
        });
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          process.kill(pid, 'SIGKILL');
        }
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

export async function executeSandboxedCommand(params: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutputChunk?: (liveText: string) => void;
}): Promise<{ exitCode: number; output: string; savedTokensApprox: number }> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const maxBufferBytes = 4 * 1024 * 1024;

  return new Promise((resolve) => {
    const child = spawn(params.command, {
      cwd: params.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let combined = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let lastEmitAt = 0;
    let emitTimer: NodeJS.Timeout | null = null;

    const emitTail = (force = false) => {
      if (!params.onOutputChunk) return;
      const now = Date.now();
      const tail = combined.slice(-3000);
      if (force || now - lastEmitAt >= 120) {
        lastEmitAt = now;
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = null;
        }
        params.onOutputChunk(tail);
      } else if (!emitTimer) {
        emitTimer = setTimeout(() => {
          emitTimer = null;
          lastEmitAt = Date.now();
          params.onOutputChunk?.(combined.slice(-3000));
        }, 120);
      }
    };

    const appendChunk = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (combined.length < maxBufferBytes) {
        combined += text.slice(0, maxBufferBytes - combined.length);
      }
      emitTail(false);
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (emitTimer) {
        clearTimeout(emitTimer);
        emitTimer = null;
      }
      params.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (exitCode: number, extraNote?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      emitTail(true);
      let raw = extraNote ? [combined, extraNote].filter(Boolean).join('\n') : combined;
      if (
        process.platform === 'win32' &&
        exitCode !== 0 &&
        /is not recognized as an internal or external command/i.test(raw) &&
        /'(?:sleep|cat|head|tail|grep|ls|rm|touch|wc|sed|awk|which)'/i.test(raw)
      ) {
        raw +=
          '\n[Windows cmd.exe hint: POSIX commands (sleep/cat/head/tail/grep/ls/rm) are unavailable. Use read_range/repo_search/delete_file tools, or Windows/Python commands (type, findstr, dir, python -c "import time; time.sleep(1)").]';
      }
      const digested = digestCommandOutput(raw, exitCode, 2200);
      resolve({
        exitCode,
        output:
          digested.text ||
          (exitCode === 0
            ? '(command completed with exit code 0 and no output)'
            : `(command exited with code ${exitCode})`),
        savedTokensApprox: digested.savedTokensApprox,
      });
    };

    const onAbort = () => {
      if (aborted || settled) return;
      aborted = true;
      void killProcessTree(child.pid).then(() => {
        finish(130, 'Command cancelled by abort signal.');
      });
    };

    if (params.signal?.aborted) {
      onAbort();
      return;
    }

    params.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      if (timedOut || settled) return;
      timedOut = true;
      void killProcessTree(child.pid).then(() => {
        finish(124, `Command timed out after ${Math.round(timeoutMs / 1000)}s.`);
      });
    }, timeoutMs);

    child.stdout?.on('data', appendChunk);
    child.stderr?.on('data', appendChunk);

    child.on('error', (err) => {
      finish(1, err.message);
    });

    child.on('close', (code) => {
      if (aborted || timedOut) return;
      finish(typeof code === 'number' ? code : 1);
    });
  });
}
