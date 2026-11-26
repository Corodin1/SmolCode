import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL DEFAULT 'main',
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'local',
        worktree_path TEXT,
        worktree_branch TEXT,
        base_branch TEXT NOT NULL DEFAULT 'main',
        main_model TEXT NOT NULL,
        fast_model TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'medium',
        approval_policy TEXT NOT NULL DEFAULT 'auto',
        draft_text TEXT NOT NULL DEFAULT '',
        draft_chips_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'idle',
        unread INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_threads_project_updated
        ON threads(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        chips_json TEXT,
        thinking TEXT,
        tool_calls_json TEXT,
        ledger_json TEXT,
        telemetry_json TEXT,
        snapshot_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turns_thread_created
        ON turns(thread_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        workdir TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ast_cache (
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        content_hash TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        imports_json TEXT NOT NULL,
        PRIMARY KEY (project_id, file_path)
      );

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'worktree',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_thread_id TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'build';
      ALTER TABLE threads ADD COLUMN queued_prompts_json TEXT NOT NULL DEFAULT '[]';

      ALTER TABLE turns ADD COLUMN plan_json TEXT;
      ALTER TABLE turns ADD COLUMN question_json TEXT;

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL DEFAULT 'stdio',
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        tools_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_environments (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        setup_script TEXT NOT NULL DEFAULT '',
        env_vars_json TEXT NOT NULL DEFAULT '{}',
        auto_run_on_worktree INTEGER NOT NULL DEFAULT 1
      );
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE ast_cache ADD COLUMN line_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE turns ADD COLUMN generated_images_json TEXT;
    `,
  },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS max_ver FROM schema_migrations')
    .get() as { max_ver: number } | undefined;
  const currentVersion = row?.max_ver ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec('BEGIN;');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      );
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
}
