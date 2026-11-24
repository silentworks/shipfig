import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Durable SQLite store (single-instance MVP). Uses Node's built-in
 * `node:sqlite`. The file lives at SHIPFIG_DB_PATH, default `.data/shipfig.db`.
 */

const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id                TEXT PRIMARY KEY,
    repo_owner        TEXT NOT NULL,
    repo_name         TEXT NOT NULL,
    issue_number      INTEGER NOT NULL,
    issue_title       TEXT NOT NULL,
    issue_url         TEXT NOT NULL,
    state             TEXT NOT NULL,
    -- 1 while the job is non-terminal, NULL once terminal. The unique index
    -- below makes "at most one active job" a database invariant.
    active            INTEGER,
    failure_reason    TEXT,
    cancel_reason     TEXT,
    error             TEXT,
    sprite_name       TEXT,
    branch_name       TEXT,
    plan              TEXT,
    test_results      TEXT,
    diff              TEXT,
    pr_url            TEXT,
    retry_count       INTEGER NOT NULL DEFAULT 0,
    attempt           INTEGER NOT NULL DEFAULT 1,
    version           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    state_entered_at  TEXT NOT NULL,
    deadline_at       TEXT,
    finished_at       TEXT,
    CHECK (active IS NULL OR active = 1)
  );
  CREATE UNIQUE INDEX jobs_one_active ON jobs(active);
  CREATE INDEX jobs_created_at ON jobs(created_at DESC);

  CREATE TABLE job_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    at          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT,
    message     TEXT NOT NULL,
    data        TEXT
  );
  CREATE INDEX job_events_job ON job_events(job_id, id);
  `,
  // v2 (SIL-530): workspace provenance.
  `
  ALTER TABLE jobs ADD COLUMN sprite_id TEXT;
  ALTER TABLE jobs ADD COLUMN base_branch TEXT;
  ALTER TABLE jobs ADD COLUMN base_sha TEXT;
  ALTER TABLE jobs ADD COLUMN checkpoint_id TEXT;
  ALTER TABLE jobs ADD COLUMN workspace TEXT;
  `,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

const globalForDb = globalThis as unknown as { __shipfigDb?: DatabaseSync };

/** Process-wide database handle (survives Next.js dev hot reloads). */
export function database(): DatabaseSync {
  globalForDb.__shipfigDb ??= openDatabase(process.env.SHIPFIG_DB_PATH || ".data/shipfig.db");
  return globalForDb.__shipfigDb;
}
