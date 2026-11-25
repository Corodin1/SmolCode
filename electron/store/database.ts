import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings,
  AutomationRule,
  ComposerChip,
  McpServerConfig,
  McpToolSummary,
  ProjectEnvironment,
  ProjectRecord,
  QueuedPromptItem,
  StructuredPlan,
  ThreadRecord,
  ThreadStatus,
  TurnRecord,
  UserQuestionPrompt,
} from '../../src/shared/types';
import { runMigrations } from './migrations';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  vramScheduleMode: 'stage-batched',
  pinFastToCpu: false,
  theme: 'dark',
  themePreset: 'obsidian',
  accentColor: 'blue',
  uiDensity: 'comfortable',
  fontSize: 'md',
  glassIntensity: 'subtle',
  reduceMotion: false,
  defaultMainModel: '',
  defaultFastModel: '',
  defaultEffort: 'medium',
  defaultApprovalPolicy: 'auto',
  defaultShell: 'auto',
  preferredEditor: 'auto',
  notifyOnComplete: true,
  soundOnComplete: true,
  sttEndpointUrl: '',
  sttModel: 'whisper-1',
  showAdvancedDualModel: false,
  webLookupEnabled: true,
  obscuraPath: '',
};

export interface AstCacheRow {
  projectId: string;
  filePath: string;
  mtimeMs: number;
  contentHash: string;
  symbolsJson: string;
  importsJson: string;
  lineCount: number;
}

export interface SnapshotRow {
  id: string;
  threadId: string;
  workdir: string;
  manifestJson: string;
  createdAt: number;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export type CreateThreadInput = Omit<
  ThreadRecord,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'archived'
  | 'interactionMode'
  | 'queuedPrompts'
> & {
  id?: string;
  archived?: boolean;
  interactionMode?: ThreadRecord['interactionMode'];
  queuedPrompts?: QueuedPromptItem[];
};

export class SmolCodeStore {
  readonly db: DatabaseSync;
  readonly baseDir: string;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ?? join(homedir(), '.smolcode', 'smolcode.db');
    this.baseDir =
      resolvedPath === ':memory:'
        ? join(homedir(), '.smolcode')
        : dirname(resolvedPath);
    if (resolvedPath !== ':memory:') {
      mkdirSync(this.baseDir, { recursive: true });
    }
    this.db = new DatabaseSync(resolvedPath);
    if (resolvedPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  getSettings(): AppSettings {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('app_settings') as { value_json: string } | undefined;
    if (!row) return { ...DEFAULT_APP_SETTINGS };
    return {
      ...DEFAULT_APP_SETTINGS,
      ...safeJsonParse<Partial<AppSettings>>(row.value_json, {}),
    };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...patch };
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run('app_settings', JSON.stringify(next));
    return next;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at ASC')
      .all() as Array<{
      id: string;
      name: string;
      root_path: string;
      collapsed: number;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      collapsed: Boolean(row.collapsed),
      createdAt: row.created_at,
    }));
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as
      | {
          id: string;
          name: string;
          root_path: string;
          collapsed: number;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      collapsed: Boolean(row.collapsed),
      createdAt: row.created_at,
    };
  }

  upsertProject(input: { name: string; rootPath: string }): ProjectRecord {
    const existing = this.db
      .prepare('SELECT * FROM projects WHERE root_path = ?')
      .get(input.rootPath) as
      | {
          id: string;
          name: string;
          root_path: string;
          collapsed: number;
          created_at: number;
        }
      | undefined;
    if (existing) {
      return {
        id: existing.id,
        name: existing.name,
        rootPath: existing.root_path,
        collapsed: Boolean(existing.collapsed),
        createdAt: existing.created_at,
      };
    }
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, default_branch, collapsed, created_at)
         VALUES (?, ?, ?, 'local', 0, ?)`,
      )
      .run(id, input.name, input.rootPath, createdAt);
    return {
      id,
      name: input.name,
      rootPath: input.rootPath,
      collapsed: false,
      createdAt,
    };
  }

  setProjectCollapsed(projectId: string, collapsed: boolean): void {
    this.db
      .prepare('UPDATE projects SET collapsed = ? WHERE id = ?')
      .run(collapsed ? 1 : 0, projectId);
  }

  removeProject(projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  }

  private mapThreadRow(row: Record<string, unknown>): ThreadRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      interactionMode: (row.interaction_mode as ThreadRecord['interactionMode']) || 'build',
      mainModel: String(row.main_model),
      fastModel: String(row.fast_model),
      effort: row.effort as ThreadRecord['effort'],
      approvalPolicy: row.approval_policy as ThreadRecord['approvalPolicy'],
      draftText: String(row.draft_text ?? ''),
      draftChips: safeJsonParse<ComposerChip[]>(
        row.draft_chips_json as string | undefined,
        [],
      ),
      queuedPrompts: safeJsonParse<QueuedPromptItem[]>(
        row.queued_prompts_json as string | undefined,
        [],
      ),
      status: row.status as ThreadStatus,
      unread: Boolean(row.unread),
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listThreads(projectId?: string): ThreadRecord[] {
    const rows = projectId
      ? (this.db
          .prepare(
            'SELECT * FROM threads WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC',
          )
          .all(projectId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM threads ORDER BY pinned DESC, updated_at DESC')
          .all() as Array<Record<string, unknown>>);
    return rows.map((row) => this.mapThreadRow(row));
  }

  getThread(threadId: string): ThreadRecord | null {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE id = ?')
      .get(threadId) as Record<string, unknown> | undefined;
    return row ? this.mapThreadRow(row) : null;
  }

  createThread(input: CreateThreadInput): ThreadRecord {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const interactionMode = input.interactionMode ?? 'build';
    const queuedPrompts = input.queuedPrompts ?? [];
    const archived = Boolean(input.archived);
    this.db
      .prepare(
        `INSERT INTO threads (
          id, project_id, title, mode, interaction_mode, worktree_path, worktree_branch, base_branch,
          main_model, fast_model, effort, approval_policy, draft_text, draft_chips_json,
          queued_prompts_json, status, unread, pinned, archived, created_at, updated_at
        ) VALUES (?, ?, ?, 'local', ?, NULL, NULL, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title,
        interactionMode,
        input.mainModel,
        input.fastModel,
        input.effort,
        input.approvalPolicy,
        input.draftText,
        JSON.stringify(input.draftChips ?? []),
        JSON.stringify(queuedPrompts),
        input.status,
        input.unread ? 1 : 0,
        input.pinned ? 1 : 0,
        archived ? 1 : 0,
        now,
        now,
      );
    return {
      ...input,
      id,
      interactionMode,
      queuedPrompts,
      archived,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateThread(threadId: string, patch: Partial<ThreadRecord>): ThreadRecord {
    const current = this.getThread(threadId);
    if (!current) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const next: ThreadRecord = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE threads SET
          title = ?, interaction_mode = ?,
          main_model = ?, fast_model = ?, effort = ?, approval_policy = ?,
          draft_text = ?, draft_chips_json = ?, queued_prompts_json = ?,
          status = ?, unread = ?, pinned = ?, archived = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.interactionMode,
        next.mainModel,
        next.fastModel,
        next.effort,
        next.approvalPolicy,
        next.draftText,
        JSON.stringify(next.draftChips ?? []),
        JSON.stringify(next.queuedPrompts ?? []),
        next.status,
        next.unread ? 1 : 0,
        next.pinned ? 1 : 0,
        next.archived ? 1 : 0,
        next.updatedAt,
        threadId,
      );
    return next;
  }

  deleteThread(threadId: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  }

  private mapTurnRow(row: Record<string, unknown>): TurnRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      role: row.role as TurnRecord['role'],
      content: String(row.content),
      chips: safeJsonParse(row.chips_json as string | undefined, undefined),
      thinking: (row.thinking as string | null) ?? undefined,
      toolCalls: safeJsonParse(row.tool_calls_json as string | undefined, undefined),
      plan: safeJsonParse<StructuredPlan | undefined>(
        row.plan_json as string | undefined,
        undefined,
      ),
      questionPrompt: safeJsonParse<UserQuestionPrompt | undefined>(
        row.question_json as string | undefined,
        undefined,
      ),
      ledger: safeJsonParse(row.ledger_json as string | undefined, undefined),
      telemetry: safeJsonParse(row.telemetry_json as string | undefined, undefined),
      snapshotId: (row.snapshot_id as string | null) ?? null,
      createdAt: Number(row.created_at),
    };
  }

  listTurns(threadId: string): TurnRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(threadId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapTurnRow(row));
  }

  insertTurn(turn: TurnRecord): TurnRecord {
    this.db
      .prepare(
        `INSERT INTO turns (
          id, thread_id, role, content, chips_json, thinking,
          tool_calls_json, plan_json, question_json, ledger_json, telemetry_json, snapshot_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.threadId,
        turn.role,
        turn.content,
        turn.chips ? JSON.stringify(turn.chips) : null,
        turn.thinking ?? null,
        turn.toolCalls ? JSON.stringify(turn.toolCalls) : null,
        turn.plan ? JSON.stringify(turn.plan) : null,
        turn.questionPrompt ? JSON.stringify(turn.questionPrompt) : null,
        turn.ledger ? JSON.stringify(turn.ledger) : null,
        turn.telemetry ? JSON.stringify(turn.telemetry) : null,
        turn.snapshotId ?? null,
        turn.createdAt,
      );
    this.db
      .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
      .run(Date.now(), turn.threadId);
    return turn;
  }

  updateTurn(turnId: string, patch: Partial<TurnRecord>): void {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE id = ?')
      .get(turnId) as Record<string, unknown> | undefined;
    if (!row) return;
    const current = this.mapTurnRow(row);
    const next: TurnRecord = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE turns SET
          content = ?, thinking = ?, tool_calls_json = ?,
          plan_json = ?, question_json = ?,
          ledger_json = ?, telemetry_json = ?, snapshot_id = ?
         WHERE id = ?`,
      )
      .run(
        next.content,
        next.thinking ?? null,
        next.toolCalls ? JSON.stringify(next.toolCalls) : null,
        next.plan ? JSON.stringify(next.plan) : null,
        next.questionPrompt ? JSON.stringify(next.questionPrompt) : null,
        next.ledger ? JSON.stringify(next.ledger) : null,
        next.telemetry ? JSON.stringify(next.telemetry) : null,
        next.snapshotId ?? null,
        turnId,
      );
  }

  deleteTurnsAfter(threadId: string, targetTurnId: string): void {
    const turns = this.listTurns(threadId);
    const idx = turns.findIndex((t) => t.id === targetTurnId);
    if (idx === -1) return;
    const toDelete = turns.slice(idx);
    const stmt = this.db.prepare('DELETE FROM turns WHERE id = ?');
    for (const turn of toDelete) {
      stmt.run(turn.id);
    }
  }

  replaceTurnsWithCompactSummary(threadId: string, summaryTurn: TurnRecord): void {
    this.db.exec('BEGIN;');
    try {
      this.db.prepare('DELETE FROM turns WHERE thread_id = ?').run(threadId);
      this.insertTurn(summaryTurn);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  saveSnapshot(row: SnapshotRow): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (id, thread_id, workdir, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.threadId, row.workdir, row.manifestJson, row.createdAt);
  }

  getSnapshot(snapshotId: string): SnapshotRow | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE id = ?')
      .get(snapshotId) as
      | {
          id: string;
          thread_id: string;
          workdir: string;
          manifest_json: string;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      threadId: row.thread_id,
      workdir: row.workdir,
      manifestJson: row.manifest_json,
      createdAt: row.created_at,
    };
  }

  getAstCache(projectId: string): AstCacheRow[] {
    const rows = this.db
      .prepare('SELECT * FROM ast_cache WHERE project_id = ?')
      .all(projectId) as Array<{
      project_id: string;
      file_path: string;
      mtime_ms: number;
      content_hash: string;
      symbols_json: string;
      imports_json: string;
      line_count?: number;
    }>;
    return rows.map((row) => ({
      projectId: row.project_id,
      filePath: row.file_path,
      mtimeMs: row.mtime_ms,
      contentHash: row.content_hash,
      symbolsJson: row.symbols_json,
      importsJson: row.imports_json,
      lineCount: Number(row.line_count ?? 0),
    }));
  }

  upsertAstCache(row: AstCacheRow): void {
    this.db
      .prepare(
        `INSERT INTO ast_cache (project_id, file_path, mtime_ms, content_hash, symbols_json, imports_json, line_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, file_path) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           content_hash = excluded.content_hash,
           symbols_json = excluded.symbols_json,
           imports_json = excluded.imports_json,
           line_count = excluded.line_count`,
      )
      .run(
        row.projectId,
        row.filePath,
        row.mtimeMs,
        row.contentHash,
        row.symbolsJson,
        row.importsJson,
        row.lineCount,
      );
  }

  deleteAstCacheMissing(projectId: string, existingFiles: Set<string>): void {
    const rows = this.db
      .prepare('SELECT file_path FROM ast_cache WHERE project_id = ?')
      .all(projectId) as Array<{ file_path: string }>;
    const del = this.db.prepare(
      'DELETE FROM ast_cache WHERE project_id = ? AND file_path = ?',
    );
    for (const row of rows) {
      if (!existingFiles.has(row.file_path)) {
        del.run(projectId, row.file_path);
      }
    }
  }

  listAutomations(projectId?: string): AutomationRule[] {
    const rows = projectId
      ? (this.db
          .prepare('SELECT * FROM automations WHERE project_id = ? ORDER BY name ASC')
          .all(projectId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM automations ORDER BY name ASC')
          .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      name: String(row.name),
      prompt: String(row.prompt),
      cronExpr: String(row.cron_expr),
      enabled: Boolean(row.enabled),
      lastRunAt: (row.last_run_at as number | null) ?? null,
      lastStatus: row.last_status as AutomationRule['lastStatus'],
      lastThreadId: (row.last_thread_id as string | null) ?? null,
    }));
  }

  saveAutomation(
    rule: Partial<AutomationRule> & { projectId: string },
  ): AutomationRule {
    const existing = rule.id
      ? this.listAutomations(rule.projectId).find((a) => a.id === rule.id)
      : undefined;
    const next: AutomationRule = {
      id: existing?.id ?? rule.id ?? randomUUID(),
      projectId: rule.projectId,
      name: rule.name ?? existing?.name ?? 'Untitled automation',
      prompt: rule.prompt ?? existing?.prompt ?? '',
      cronExpr: rule.cronExpr ?? existing?.cronExpr ?? '0 * * * *',
      enabled: rule.enabled ?? existing?.enabled ?? true,
      lastRunAt: rule.lastRunAt ?? existing?.lastRunAt ?? null,
      lastStatus: rule.lastStatus ?? existing?.lastStatus ?? 'idle',
      lastThreadId: rule.lastThreadId ?? existing?.lastThreadId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO automations (
          id, project_id, name, prompt, cron_expr, mode, enabled, last_run_at, last_status, last_thread_id
        ) VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          prompt = excluded.prompt,
          cron_expr = excluded.cron_expr,
          mode = 'local',
          enabled = excluded.enabled,
          last_run_at = excluded.last_run_at,
          last_status = excluded.last_status,
          last_thread_id = excluded.last_thread_id`,
      )
      .run(
        next.id,
        next.projectId,
        next.name,
        next.prompt,
        next.cronExpr,
        next.enabled ? 1 : 0,
        next.lastRunAt,
        next.lastStatus,
        next.lastThreadId,
      );
    return next;
  }

  deleteAutomation(id: string): void {
    this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
  }

  getProjectEnvironment(projectId: string): ProjectEnvironment {
    const row = this.db
      .prepare('SELECT * FROM project_environments WHERE project_id = ?')
      .get(projectId) as
      | {
          project_id: string;
          setup_script: string;
          env_vars_json: string;
        }
      | undefined;
    if (!row) {
      return {
        projectId,
        setupScript: '',
        envVarsJson: '{}',
      };
    }
    return {
      projectId: row.project_id,
      setupScript: row.setup_script,
      envVarsJson: row.env_vars_json,
    };
  }

  saveProjectEnvironment(env: ProjectEnvironment): ProjectEnvironment {
    this.db
      .prepare(
        `INSERT INTO project_environments (project_id, setup_script, env_vars_json, auto_run_on_worktree)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(project_id) DO UPDATE SET
           setup_script = excluded.setup_script,
           env_vars_json = excluded.env_vars_json`,
      )
      .run(env.projectId, env.setupScript, env.envVarsJson || '{}');
    return env;
  }

  listMcpServers(): McpServerConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_servers ORDER BY name ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      transport: (row.transport as McpServerConfig['transport']) || 'stdio',
      command: (row.command as string | null) ?? undefined,
      args: safeJsonParse<string[]>(row.args_json as string | undefined, []),
      url: (row.url as string | null) ?? undefined,
      env: safeJsonParse<Record<string, string>>(row.env_json as string | undefined, {}),
      enabled: Boolean(row.enabled),
      lastStatus: (row.last_status as McpServerConfig['lastStatus']) || 'idle',
      lastError: (row.last_error as string | null) ?? undefined,
      tools: safeJsonParse<McpToolSummary[]>(row.tools_json as string | undefined, []),
    }));
  }

  saveMcpServer(server: Partial<McpServerConfig> & { name: string }): McpServerConfig {
    const existing = server.id
      ? this.listMcpServers().find((s) => s.id === server.id)
      : this.listMcpServers().find((s) => s.name === server.name);
    const next: McpServerConfig = {
      id: existing?.id ?? server.id ?? randomUUID(),
      name: server.name.trim(),
      transport: server.transport ?? existing?.transport ?? 'stdio',
      command: server.command ?? existing?.command,
      args: server.args ?? existing?.args ?? [],
      url: server.url ?? existing?.url,
      env: server.env ?? existing?.env ?? {},
      enabled: server.enabled ?? existing?.enabled ?? true,
      lastStatus: server.lastStatus ?? existing?.lastStatus ?? 'idle',
      lastError: server.lastError,
      tools: server.tools ?? existing?.tools ?? [],
    };
    this.db
      .prepare(
        `INSERT INTO mcp_servers (
          id, name, transport, command, args_json, url, env_json, enabled, last_status, last_error, tools_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          transport = excluded.transport,
          command = excluded.command,
          args_json = excluded.args_json,
          url = excluded.url,
          env_json = excluded.env_json,
          enabled = excluded.enabled,
          last_status = excluded.last_status,
          last_error = excluded.last_error,
          tools_json = excluded.tools_json`,
      )
      .run(
        next.id,
        next.name,
        next.transport,
        next.command ?? null,
        JSON.stringify(next.args ?? []),
        next.url ?? null,
        JSON.stringify(next.env ?? {}),
        next.enabled ? 1 : 0,
        next.lastStatus ?? 'idle',
        next.lastError ?? null,
        JSON.stringify(next.tools ?? []),
        Date.now(),
      );
    return next;
  }

  deleteMcpServer(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }
}
