import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpManager } from '../../electron/mcp/mcp-manager';
import type { McpServerConfig } from '../../src/shared/types';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('Persistent McpManager pooling', () => {
  it('reuses a single stdio child process across multiple calls, reconnects on crash, and closes on closeAll', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolcode-mcp-pool-'));
    const serverScript = join(dir, 'mock-mcp.mjs');

    writeFileSync(
      serverScript,
      `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let callCount = 0;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'Ping' }] } }) + '\\n');
  } else if (msg.method === 'tools/call') {
    callCount += 1;
    if (msg.params?.arguments?.crash) {
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, callCount }) }] }
    }) + '\\n');
  }
});
`,
      'utf8',
    );

    const mcp = new McpManager();
    cleanups.push(
      () => mcp.closeAll(),
      () => rmSync(dir, { recursive: true, force: true }),
    );

    const cfg: McpServerConfig = {
      id: 'srv-stdio',
      name: 'mock-stdio',
      transport: 'stdio',
      command: process.execPath,
      args: [serverScript],
      enabled: true,
    };

    const tools = await mcp.listTools(cfg);
    expect(tools).toHaveLength(1);
    expect(mcp.hasActiveSession(cfg.id)).toBe(true);

    const res1 = await mcp.callTool(cfg, 'ping', {});
    const res2 = await mcp.callTool(cfg, 'ping', {});
    const data1 = JSON.parse(res1.output) as { pid: number; callCount: number };
    const data2 = JSON.parse(res2.output) as { pid: number; callCount: number };

    // Same process PID and incremented in-process counter prove persistent pooling
    expect(data1.pid).toBe(data2.pid);
    expect(data1.callCount).toBe(1);
    expect(data2.callCount).toBe(2);

    // Simulate server crash -> failing call rejects and evicts dead session, next call transparently reconnects
    await expect(mcp.callTool(cfg, 'ping', { crash: true })).rejects.toThrow(/exited/i);
    expect(mcp.hasActiveSession(cfg.id)).toBe(false);

    const resAfterCrash = await mcp.callTool(cfg, 'ping', {});
    const data3 = JSON.parse(resAfterCrash.output) as { pid: number; callCount: number };
    expect(data3.pid).not.toBe(data2.pid);
    expect(data3.callCount).toBe(1);

    await mcp.closeAll();
    expect(mcp.hasActiveSession(cfg.id)).toBe(false);
  });

  it('maintains Mcp-Session-Id across Streamable HTTP calls and re-initializes on 404', async () => {
    let activeSession = 'sess-1';
    let initCount = 0;

    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
        if (msg.method === 'initialize') {
          initCount += 1;
          activeSession = `sess-${initCount}`;
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': activeSession,
          });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
          return;
        }
        if (msg.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        const reqSession = req.headers['mcp-session-id'];
        if (reqSession !== activeSession) {
          res.writeHead(404);
          res.end('Session expired');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `ok:${activeSession}` }] },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const mcp = new McpManager();
    cleanups.push(
      () => mcp.closeAll(),
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    const cfg: McpServerConfig = {
      id: 'srv-http',
      name: 'mock-http',
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      enabled: true,
    };

    const r1 = await mcp.callTool(cfg, 'echo', {});
    expect(r1.output).toBe('ok:sess-1');
    expect(initCount).toBe(1);

    // Second call reuses sess-1 without re-initializing
    const r2 = await mcp.callTool(cfg, 'echo', {});
    expect(r2.output).toBe('ok:sess-1');
    expect(initCount).toBe(1);

    // Expire server session -> client receives 404, re-initializes to sess-2, and succeeds
    activeSession = 'expired';
    const r3 = await mcp.callTool(cfg, 'echo', {});
    expect(r3.output).toBe('ok:sess-2');
    expect(initCount).toBe(2);
  });
});
