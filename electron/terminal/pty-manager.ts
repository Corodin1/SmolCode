import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AppSettings } from '../../src/shared/types';

const ptyRequire = createRequire(import.meta.url);

interface PtyHandle {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (ev: { exitCode: number }) => void): void;
}

export function resolveWindowsShell(pref: AppSettings['defaultShell']): {
  shell: string;
  args: string[];
  label: string;
} {
  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    return { shell: sh, args: [], label: sh };
  }

  if (pref === 'wsl') {
    return { shell: 'wsl.exe', args: [], label: 'WSL' };
  }
  if (pref === 'git-bash') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (existsSync(gitBash)) {
      return { shell: gitBash, args: ['--login', '-i'], label: 'Git Bash' };
    }
  }
  if (pref === 'pwsh' || pref === 'auto') {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    if (existsSync(pwsh)) {
      return { shell: pwsh, args: ['-NoLogo'], label: 'PowerShell 7' };
    }
  }
  return { shell: 'powershell.exe', args: ['-NoLogo'], label: 'Windows PowerShell' };
}

export class PtyManager {
  private sessions = new Map<string, PtyHandle>();

  constructor(
    private readonly emitData: (ptyId: string, data: string) => void,
    private readonly emitExit: (ptyId: string, code: number) => void,
  ) {}

  spawn(params: {
    cwd: string;
    cols: number;
    rows: number;
    shellPref: AppSettings['defaultShell'];
  }): { ptyId: string; cwd: string; shell: string } {
    const resolvedEntry = ptyRequire.resolve('@lydell/node-pty');
    const unpackedEntry = resolvedEntry.replace('app.asar', 'app.asar.unpacked');
    const nodePty = ptyRequire(
      existsSync(unpackedEntry) ? unpackedEntry : '@lydell/node-pty',
    ) as {
      spawn: (
        file: string,
        args: string[],
        opts: Record<string, unknown>,
      ) => PtyHandle;
    };

    const resolved = resolveWindowsShell(params.shellPref);
    const ptyId = randomUUID();
    const proc = nodePty.spawn(resolved.shell, resolved.args, {
      name: 'xterm-256color',
      cols: Math.max(20, params.cols),
      rows: Math.max(5, params.rows),
      cwd: params.cwd,
      env: process.env,
    });

    this.sessions.set(ptyId, proc);
    proc.onData((data) => this.emitData(ptyId, data));
    proc.onExit((ev) => {
      this.sessions.delete(ptyId);
      this.emitExit(ptyId, ev.exitCode ?? 0);
    });

    return { ptyId, cwd: params.cwd, shell: resolved.label };
  }

  write(ptyId: string, data: string): void {
    this.sessions.get(ptyId)?.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.sessions.get(ptyId)?.resize(Math.max(20, cols), Math.max(5, rows));
  }

  close(ptyId: string): void {
    const handle = this.sessions.get(ptyId);
    if (!handle) return;
    this.sessions.delete(ptyId);
    try {
      handle.kill();
    } catch {
      // Already exited
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
  }
}
