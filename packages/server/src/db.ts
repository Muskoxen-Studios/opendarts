import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistence uses node:sqlite, which ships with Node itself. That keeps the
 * dependency tree free of a native module while still giving us real queries
 * over long-term history.
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#4f8ef7',
      avatar      TEXT,
      created_at  TEXT NOT NULL,
      -- Soft delete: a removed profile must not erase the matches it played in.
      deleted_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS matches (
      id          TEXT PRIMARY KEY,
      game_type   TEXT NOT NULL,
      config_json TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      winner_id   TEXT
    );

    CREATE TABLE IF NOT EXISTS match_players (
      match_id      TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      profile_id    TEXT NOT NULL,
      seat          INTEGER NOT NULL,
      handicap_json TEXT,
      PRIMARY KEY (match_id, profile_id)
    );

    -- THE SOURCE OF TRUTH. Everything below this line is a projection that can
    -- be dropped and rebuilt from these rows.
    CREATE TABLE IF NOT EXISTS commands (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id     TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      ts           TEXT NOT NULL,
      type         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (match_id, seq)
    );

    CREATE TABLE IF NOT EXISTS throws (
      id             TEXT PRIMARY KEY,
      match_id       TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      profile_id     TEXT NOT NULL,
      leg            INTEGER NOT NULL,
      dart_no        INTEGER NOT NULL,
      segment_number INTEGER NOT NULL,
      segment_ring   TEXT NOT NULL,
      value          INTEGER NOT NULL,
      counted        INTEGER NOT NULL,
      -- Nullable and unpopulated: the board reports coordinates but their units
      -- and origin are not yet established. The column exists now so historical
      -- throws gain coordinates by backfill, with no migration.
      coords_json    TEXT
    );

    CREATE TABLE IF NOT EXISTS stats_cache (
      profile_id TEXT NOT NULL,
      metric     TEXT NOT NULL,
      value      REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, metric)
    );

    CREATE TABLE IF NOT EXISTS achievements (
      profile_id     TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at    TEXT,
      progress       REAL NOT NULL DEFAULT 0,
      goal           REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (profile_id, achievement_id)
    );

    -- A leaderboard reset does not delete anything: it archives a condensed
    -- snapshot of the table and moves the epoch it counts from. The matches
    -- themselves stay in the commands table, which is still the only source of truth.
    CREATE TABLE IF NOT EXISTS leaderboard_archives (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      -- The window the archived table covered. from_ts is null for the first
      -- season, which counted from the very first match played.
      from_ts    TEXT,
      to_ts      TEXT NOT NULL,
      matches    INTEGER NOT NULL,
      rows_json  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_commands_match ON commands(match_id, seq);
    CREATE INDEX IF NOT EXISTS idx_throws_profile ON throws(profile_id);
    CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at);
  `);

}

/** Additive migration for databases created before a column existed. */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
