import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerConfig, McpToolSummary } from '../../src/shared/types';

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface StdioSession {
  serverId: string;
  serverName: string;
  signature: string;
  child: ChildProcess;
  pending: Map<number, PendingRpc>;
  stdoutBuf: string;
  stderrTail: string;
  readyPromise: Promise<void>;
  closed: boolean;
}

interface HttpSession {
  serverId: string;
  signature: string;
  sessionId?: string;
  initialized: boolean;
  initPromise?: Promise<void>;
}

function computeConfigSignature(server: McpServerConfig): string {
  const envEntries = Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    transport: server.transport,
    command: server.command ?? '',
    args: server.args ?? [],
    url: server.url ?? '',
    env: envEntries,
  });
}

function parseSseOrJsonPayload(contentType: string, rawText: string, expectedId?: number): JsonRpcResponse {
  if (!contentType.includes('text/event-stream')) {
    return JSON.parse(rawText) as JsonRpcResponse;
  }
  const lines = rawText.split(/\r?\n/);
  let lastParsed: JsonRpcResponse | null = null;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const jsonPart = line.slice(5).trim();
    if (!jsonPart || jsonPart === '[DONE]') continue;
    try {
      const msg = JSON.parse(jsonPart) as JsonRpcResponse;
      lastParsed = msg;
      if (expectedId !== undefined && msg.id === expectedId) {
        return msg;
      }
    } catch {
      // Ignore malformed SSE event data
    }
  }
  if (lastParsed) return lastParsed;
  throw new Error('Empty SSE response from MCP HTTP server');
}

export class McpManager {
  private callSeq = 1;
  private stdioPool = new Map<string, StdioSession>();
  private httpPool = new Map<string, HttpSession>();

  hasActiveSession(serverId: string): boolean {
    const stdio = this.stdioPool.get(serverId);
    if (stdio && !stdio.closed) return true;
    const http = this.httpPool.get(serverId);
    return Boolean(http?.initialized);
  }

  async invalidateServer(serverId: string): Promise<void> {
    const stdio = this.stdioPool.get(serverId);
    if (stdio) {
      this.destroyStdioSession(stdio, new Error('MCP server configuration changed.'));
    }
    const http = this.httpPool.get(serverId);
    if (http) {
      this.httpPool.delete(serverId);
    }
  }

  async closeAll(): Promise<void> {
    for (const session of [...this.stdioPool.values()]) {
      this.destroyStdioSession(session, new Error('MCP manager closed.'));
    }
    this.stdioPool.clear();
    this.httpPool.clear();
  }

  async listTools(server: McpServerConfig): Promise<McpToolSummary[]> {
    const res = await this.rpc(server, 'tools/list', {}, 10_000);
    const parsed = res as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return (parsed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }> {
    const res = (await this.rpc(
      server,
      'tools/call',
      { name: toolName, arguments: args },
      25_000,
    )) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const texts = (res.content ?? [])
      .map((c) => c.text ?? JSON.stringify(c))
      .filter(Boolean);
    return {
      output: texts.join('\n') || JSON.stringify(res),
      isError: Boolean(res.isError),
    };
  }

  private async rpc(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (server.transport === 'http') {
      return this.rpcHttpPooled(server, method, params, timeoutMs);
    }
    return this.rpcStdioPooled(server, method, params, timeoutMs);
  }

  private async rpcHttpPooled(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!server.url) {
      throw new Error(`MCP server "${server.name}" has no URL configured.`);
    }
    const sig = computeConfigSignature(server);
    let session = this.httpPool.get(server.id);
    if (session && session.signature !== sig) {
      this.httpPool.delete(server.id);
      session = undefined;
    }
    if (!session) {
      session = { serverId: server.id, signature: sig, initialized: false };
      this.httpPool.set(server.id, session);
    }

    const ensureHttpInit = async (sess: HttpSession): Promise<void> => {
      if (sess.initialized) return;
      if (sess.initPromise) return sess.initPromise;
      sess.initPromise = (async () => {
        const { result, sessionId } = await this.postHttpJsonRpc(
          server,
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'smolcode', version: '0.1.0' },
          },
          timeoutMs,
          undefined,
          true,
        );
        void result;
        if (sessionId) {
          sess.sessionId = sessionId;
        }
        await this.postHttpNotification(server, 'notifications/initialized', {}, sess.sessionId);
        sess.initialized = true;
      })().finally(() => {
        sess.initPromise = undefined;
      });
      return sess.initPromise;
    };

    await ensureHttpInit(session);

    try {
      const { result } = await this.postHttpJsonRpc(
        server,
        method,
        params,
        timeoutMs,
        session.sessionId,
        false,
      );
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('HTTP 404')) {
        // Per MCP Streamable HTTP spec, HTTP 404 means session expired; re-initialize once.
        session.initialized = false;
        session.sessionId = undefined;
        await ensureHttpInit(session);
        const { result } = await this.postHttpJsonRpc(
          server,
          method,
          params,
          timeoutMs,
          session.sessionId,
          false,
        );
        return result;
      }
      throw error;
    }
  }

  private async postHttpNotification(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<void> {
    if (!server.url) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    try {
      await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          ...(server.env ?? {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: ac.signal,
      });
    } catch {
      // Notifications may not return a body or may be optional on legacy HTTP servers
    } finally {
      clearTimeout(timer);
    }
  }

  private async postHttpJsonRpc(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string,
    isInit = false,
  ): Promise<{ result: unknown; sessionId?: string }> {
    const id = this.callSeq++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(server.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(!isInit && sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          ...(server.env ?? {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ac.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} from MCP server "${server.name}"`);
      }
      const nextSessionId = resp.headers.get('Mcp-Session-Id') ?? resp.headers.get('mcp-session-id') ?? undefined;
      const contentType = resp.headers.get('content-type') ?? 'application/json';
      const rawText = await resp.text();
      const json = parseSseOrJsonPayload(contentType, rawText, id);
      if (json.error) {
        throw new Error(json.error.message || `MCP error ${json.error.code ?? -1}`);
      }
      return { result: json.result ?? {}, sessionId: nextSessionId };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getOrCreateStdioSession(
    server: McpServerConfig,
    initTimeoutMs: number,
  ): Promise<StdioSession> {
    if (!server.command) {
      throw new Error(`MCP server "${server.name}" has no command configured.`);
    }
    const sig = computeConfigSignature(server);
    const existing = this.stdioPool.get(server.id);
    if (existing && !existing.closed) {
      if (existing.signature === sig) {
        await existing.readyPromise;
        return existing;
      }
      this.destroyStdioSession(existing, new Error('MCP server configuration updated.'));
    }

    const needsShell =
      process.platform === 'win32' &&
      !/\.(exe|com)$/i.test(server.command) &&
      !server.command.includes(' ');

    const child = spawn(server.command, server.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(server.env ?? {}) },
      shell: needsShell,
      windowsHide: true,
    });

    const session: StdioSession = {
      serverId: server.id,
      serverName: server.name,
      signature: sig,
      child,
      pending: new Map(),
      stdoutBuf: '',
      stderrTail: '',
      readyPromise: Promise.resolve(),
      closed: false,
    };

    child.stderr?.on('data', (chunk) => {
      session.stderrTail = (session.stderrTail + String(chunk)).slice(-2048);
    });

    child.stdout?.on('data', (chunk) => {
      session.stdoutBuf += String(chunk);
      const lines = session.stdoutBuf.split(/\r?\n/);
      session.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse;
          if (typeof msg.id === 'number') {
            const pending = session.pending.get(msg.id);
            if (pending) {
              session.pending.delete(msg.id);
              clearTimeout(pending.timer);
              if (msg.error) {
                pending.reject(
                  new Error(msg.error.message || `MCP error ${msg.error.code ?? -1}`),
                );
              } else {
                pending.resolve(msg.result ?? {});
              }
            }
          }
        } catch {
          // Ignore non-JSON stdout diagnostics
        }
      }
    });

    child.on('error', (err) => {
      this.destroyStdioSession(session, err);
    });

    child.on('exit', (code) => {
      this.destroyStdioSession(
        session,
        new Error(
          `MCP server "${server.name}" exited (code ${code ?? -1}): ${session.stderrTail.trim().slice(0, 240)}`,
        ),
      );
    });

    this.stdioPool.set(server.id, session);

    session.readyPromise = (async () => {
      await this.sendStdioRpc(
        session,
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smolcode', version: '0.1.0' },
        },
        initTimeoutMs,
      );
      session.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
    })();

    try {
      await session.readyPromise;
      return session;
    } catch (error) {
      this.destroyStdioSession(
        session,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private sendStdioRpc(
    session: StdioSession,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (session.closed || !session.child.stdin?.writable) {
      return Promise.reject(new Error(`MCP session "${session.serverName}" is closed.`));
    }
    const id = this.callSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(
          new Error(
            `MCP server "${session.serverName}" timed out (${timeoutMs}ms). ${session.stderrTail.slice(0, 200)}`,
          ),
        );
      }, timeoutMs);

      session.pending.set(id, { resolve, reject, timer });
      try {
        session.child.stdin!.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        );
      } catch (err) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private destroyStdioSession(session: StdioSession, err: Error): void {
    if (session.closed) return;
    session.closed = true;
    if (this.stdioPool.get(session.serverId) === session) {
      this.stdioPool.delete(session.serverId);
    }
    for (const [id, pending] of session.pending) {
      session.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    try {
      session.child.kill();
    } catch {
      // Ignore already exited process
    }
  }

  private async rpcStdioPooled(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const session = await this.getOrCreateStdioSession(server, Math.min(timeoutMs, 10_000));
    return this.sendStdioRpc(session, method, params, timeoutMs);
  }
}
