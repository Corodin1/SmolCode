import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractSearchResultUrls,
  getObscuraStorageDir,
  isBundledObscuraPath,
  resolveObscuraBinary,
  runObscuraLookup,
} from '../../electron/tools/web-tools';

const cleanDirs: string[] = [];

afterEach(() => {
  while (cleanDirs.length > 0) {
    const d = cleanDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('Obscura web_lookup tool', () => {
  it('extracts and decodes DuckDuckGo result URLs cleanly', () => {
    const rawLinks = [
      'https://duckduckgo.com/y.js?ad=1',
      'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.ollama.com%2Fapi%2Fchat&rut=abc',
      'https://modelcontextprotocol.io/specification/2025-03-26/basic/transports',
    ].join('\n');

    const urls = extractSearchResultUrls(rawLinks, 3);
    expect(urls).toEqual([
      'https://docs.ollama.com/api/chat',
      'https://modelcontextprotocol.io/specification/2025-03-26/basic/transports',
    ]);
  });

  it('detects the bundled Obscura browser inside the project automatically', () => {
    const bin = resolveObscuraBinary();
    expect(bin).toBeTruthy();
    expect(existsSync(bin!)).toBe(true);
    expect(isBundledObscuraPath(bin)).toBe(true);

    const storageDir = getObscuraStorageDir();
    expect(existsSync(storageDir)).toBe(true);
  });

  it('rejects unsupported URL schemes and uses configured Obscura binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-obscura-mock-'));
    cleanDirs.push(dir);
    const mockScript = join(dir, process.platform === 'win32' ? 'mock-obscura.cmd' : 'mock-obscura.sh');
    if (process.platform === 'win32') {
      writeFileSync(mockScript, '@echo off\r\necho # Mock Obscura Markdown\r\necho Verified content\r\n', 'utf8');
    } else {
      writeFileSync(mockScript, '#!/bin/sh\necho "# Mock Obscura Markdown"\necho "Verified content"\n', { mode: 0o755 });
    }

    expect(resolveObscuraBinary(mockScript)).toBe(mockScript);

    const badScheme = await runObscuraLookup({ url: 'file:///etc/passwd', obscuraPath: mockScript });
    expect(badScheme.isError).toBe(true);
    expect(badScheme.output).toContain('Unsupported URL scheme');

    const empty = await runObscuraLookup({ obscuraPath: mockScript });
    expect(empty.isError).toBe(true);

    if (process.platform === 'win32') {
      // On Windows .cmd needs cmd /c if invoked directly via spawn without shell,
      // whereas real obscura.exe is a native binary; verify error handling cleanly if not .exe
      const exePath = resolveObscuraBinary('C:\\Tools\\obscura\\obscura.exe');
      expect(exePath).toBeTruthy();
    }
  });
});
