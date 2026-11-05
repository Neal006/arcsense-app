/**
 * Versioned migrations tracked with PRAGMA user_version. Each migration is a
 * list of single statements (better-sqlite3 prepares one statement at a time).
 * Never edit a released migration; append a new one.
 */
export interface SqlRunner {
  run(sql: string): void;
  getUserVersion(): number;
  setUserVersion(v: number): void;
  transaction(fn: () => void): void;
}

const side = (p: 'l' | 'r') => [
  `${p}_status TEXT NOT NULL CHECK (${p}_status IN ('sent','failed','skipped'))`,
  `${p}_dispatch_t REAL`,
  `${p}_write_mode TEXT CHECK (${p}_write_mode IN ('without-response','with-response'))`,
  `${p}_error TEXT`,
];

const fk = `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`;

export const MIGRATIONS: readonly (readonly string[])[] = [
  // v1: session metadata, runs, sync tokens, labels, notes, connection events
  [
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      subject_code TEXT NOT NULL,
      condition TEXT NOT NULL,
      operator TEXT NOT NULL,
      notes TEXT NOT NULL,
      planned_sides TEXT NOT NULL CHECK (planned_sides IN ('LR','L','R')),
      affected_side TEXT CHECK (affected_side IN ('L','R')),
      status TEXT NOT NULL CHECK (status IN ('created','running','stopped','aborted')),
      created_wall REAL NOT NULL,
      started_wall REAL,
      stopped_wall REAL,
      app_version TEXT NOT NULL,
      gatt_spec_version TEXT NOT NULL,
      label_catalog_version TEXT NOT NULL,
      feature_spec_hash TEXT NOT NULL,
      device_l TEXT,
      device_r TEXT,
      mode_l TEXT,
      mode_r TEXT,
      session_start_value INTEGER,
      last_token INTEGER
    )`,
    `CREATE TABLE runs (
      ${fk},
      run INTEGER NOT NULL,
      mono_at_start REAL NOT NULL,
      wall_at_start REAL NOT NULL,
      PRIMARY KEY (session_id, run)
    )`,
    `CREATE TABLE sync_tokens (
      ${fk},
      seq INTEGER NOT NULL,
      run INTEGER NOT NULL,
      token INTEGER NOT NULL CHECK (token BETWEEN 1 AND 65535),
      reason TEXT NOT NULL CHECK (reason IN ('start','periodic','manual','resync','stop')),
      t REAL NOT NULL,
      wall REAL NOT NULL,
      ${side('l').join(',\n      ')},
      ${side('r').join(',\n      ')},
      js_dispatch_skew_ms REAL,
      partial INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    )`,
    `CREATE TABLE labels (
      ${fk},
      seq INTEGER NOT NULL,
      run INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('start','end','instant','void')),
      label_group TEXT NOT NULL,
      t REAL NOT NULL,
      wall REAL NOT NULL,
      ${side('l').join(',\n      ')},
      ${side('r').join(',\n      ')},
      delivered INTEGER NOT NULL,
      voided INTEGER NOT NULL,
      voids_seq INTEGER,
      auto_closed INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    )`,
    `CREATE TABLE notes (
      ${fk},
      seq INTEGER NOT NULL,
      run INTEGER NOT NULL,
      t REAL NOT NULL,
      wall REAL NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    )`,
    `CREATE TABLE connection_events (
      ${fk},
      idx INTEGER NOT NULL,
      run INTEGER NOT NULL,
      t REAL NOT NULL,
      wall REAL NOT NULL,
      type TEXT NOT NULL,
      side TEXT CHECK (side IN ('L','R')),
      device_id TEXT,
      detail TEXT,
      PRIMARY KEY (session_id, idx)
    )`,
    `CREATE INDEX sessions_status ON sessions(status)`,
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Apply pending migrations atomically. Refuses to open a newer database. */
export function migrate(db: SqlRunner): { from: number; to: number } {
  const from = db.getUserVersion();
  if (from > SCHEMA_VERSION) {
    throw new Error(`database schema v${from} is newer than this app (v${SCHEMA_VERSION})`);
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      for (const stmt of MIGRATIONS[v]!) db.run(stmt);
      db.setUserVersion(v + 1);
    });
  }
  return { from, to: SCHEMA_VERSION };
}
