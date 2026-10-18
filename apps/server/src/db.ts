import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

/**
 * Forward-only migrations. Never edit a migration that has shipped; append a new one.
 */
const MIGRATIONS: string[] = [
  // 1: core schema
  `
  CREATE TABLE turtles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    computer_id INTEGER NOT NULL,
    label TEXT,
    world TEXT NOT NULL,
    dimension TEXT NOT NULL,
    simulated INTEGER NOT NULL DEFAULT 0,
    agent_version TEXT,
    state_json TEXT,
    pending_stop TEXT,
    last_seen INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE TABLE enrollments (
    code_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT,
    name TEXT,
    world TEXT NOT NULL,
    dimension TEXT NOT NULL,
    group_id TEXT,
    simulated INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    turtle_id TEXT NOT NULL REFERENCES turtles(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, turtle_id)
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    op TEXT,
    args_json TEXT,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    items_json TEXT NOT NULL
  );

  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    turtle_id TEXT NOT NULL,
    op TEXT NOT NULL,
    args_json TEXT NOT NULL,
    executor TEXT NOT NULL,
    status TEXT NOT NULL,
    code TEXT,
    reason TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX commands_turtle ON commands(turtle_id, created_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    turtle_id TEXT,
    message TEXT NOT NULL
  );

  -- Observed blocks. block NULL = observed air / traversed space.
  -- Unobserved cells have no row (= unknown). Staleness is derived from observed_at.
  CREATE TABLE map_blocks (
    world TEXT NOT NULL,
    dimension TEXT NOT NULL,
    x INTEGER NOT NULL,
    z INTEGER NOT NULL,
    y INTEGER NOT NULL,
    block TEXT,
    cell TEXT NOT NULL,
    state_json TEXT,
    observed_at INTEGER NOT NULL,
    source TEXT,
    PRIMARY KEY (world, dimension, x, z, y)
  ) WITHOUT ROWID;
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
