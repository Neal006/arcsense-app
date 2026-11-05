/**
 * SQLite schema (drizzle). The DDL that creates it lives in migrations.ts;
 * a test checks the two agree column for column.
 *
 * Times: `t` columns are phone-monotonic ms within an app process ("run");
 * `wall` columns are epoch ms. The runs table maps each run's monotonic base
 * to wall time so exports can place every event on one session timeline even
 * across an app restart.
 */
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  subjectCode: text('subject_code').notNull(),
  condition: text('condition').notNull(),
  operator: text('operator').notNull(),
  notes: text('notes').notNull(),
  plannedSides: text('planned_sides', { enum: ['LR', 'L', 'R'] }).notNull(),
  affectedSide: text('affected_side', { enum: ['L', 'R'] }),
  status: text('status', { enum: ['created', 'running', 'stopped', 'aborted'] }).notNull(),
  createdWall: real('created_wall').notNull(),
  startedWall: real('started_wall'),
  stoppedWall: real('stopped_wall'),
  appVersion: text('app_version').notNull(),
  gattSpecVersion: text('gatt_spec_version').notNull(),
  labelCatalogVersion: text('label_catalog_version').notNull(),
  featureSpecHash: text('feature_spec_hash').notNull(),
  deviceL: text('device_l'),
  deviceR: text('device_r'),
  modeL: text('mode_l'),
  modeR: text('mode_r'),
  sessionStartValue: integer('session_start_value'),
  lastToken: integer('last_token'),
});

export const runs = sqliteTable(
  'runs',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    run: integer('run').notNull(),
    monoAtStart: real('mono_at_start').notNull(),
    wallAtStart: real('wall_at_start').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.run] })],
);

export const syncTokens = sqliteTable(
  'sync_tokens',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    run: integer('run').notNull(),
    token: integer('token').notNull(),
    reason: text('reason', {
      enum: ['start', 'resume', 'periodic', 'manual', 'resync', 'stop'],
    }).notNull(),
    t: real('t').notNull(),
    wall: real('wall').notNull(),
    lStatus: text('l_status', { enum: ['sent', 'failed', 'skipped'] }).notNull(),
    lDispatchT: real('l_dispatch_t'),
    lWriteMode: text('l_write_mode', { enum: ['without-response', 'with-response'] }),
    lError: text('l_error'),
    rStatus: text('r_status', { enum: ['sent', 'failed', 'skipped'] }).notNull(),
    rDispatchT: real('r_dispatch_t'),
    rWriteMode: text('r_write_mode', { enum: ['without-response', 'with-response'] }),
    rError: text('r_error'),
    jsDispatchSkewMs: real('js_dispatch_skew_ms'),
    partial: integer('partial', { mode: 'boolean' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const labels = sqliteTable(
  'labels',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    run: integer('run').notNull(),
    labelId: integer('label_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['start', 'end', 'instant', 'void'] }).notNull(),
    group: text('label_group').notNull(),
    t: real('t').notNull(),
    wall: real('wall').notNull(),
    lStatus: text('l_status', { enum: ['sent', 'failed', 'skipped'] }).notNull(),
    lDispatchT: real('l_dispatch_t'),
    lWriteMode: text('l_write_mode', { enum: ['without-response', 'with-response'] }),
    lError: text('l_error'),
    rStatus: text('r_status', { enum: ['sent', 'failed', 'skipped'] }).notNull(),
    rDispatchT: real('r_dispatch_t'),
    rWriteMode: text('r_write_mode', { enum: ['without-response', 'with-response'] }),
    rError: text('r_error'),
    delivered: integer('delivered', { mode: 'boolean' }).notNull(),
    voided: integer('voided', { mode: 'boolean' }).notNull(),
    voidsSeq: integer('voids_seq'),
    autoClosed: integer('auto_closed', { mode: 'boolean' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const notes = sqliteTable(
  'notes',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    run: integer('run').notNull(),
    t: real('t').notNull(),
    wall: real('wall').notNull(),
    text: text('text').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const connectionEvents = sqliteTable(
  'connection_events',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    run: integer('run').notNull(),
    t: real('t').notNull(),
    wall: real('wall').notNull(),
    type: text('type').notNull(),
    side: text('side', { enum: ['L', 'R'] }),
    deviceId: text('device_id'),
    detail: text('detail'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.idx] })],
);

export const schema = { sessions, runs, syncTokens, labels, notes, connectionEvents };
