import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { openTestDb } from '@/testing/testDb';
import type { SyncTokenRecord } from '@/services/SyncService';
import type { LabelRecord } from '@/services/LabelService';

import { migrate, MIGRATIONS, SCHEMA_VERSION } from '../migrations';
import { schema } from '../schema';
import { SessionRepository, sqlRunnerFor, type Db, type NewSession } from '../SessionRepository';

const meta = (id: string, createdWall = 1000): NewSession => ({
  id,
  subjectCode: 'P001',
  condition: 'baseline',
  operator: 'op1',
  notes: '',
  plannedSides: 'LR',
  status: 'created',
  createdWall,
  appVersion: '0.1.0',
  gattSpecVersion: '1.0.0',
  labelCatalogVersion: '1.0.0',
  featureSpecHash: 'abc',
});

const sent = (t: number) => ({
  status: 'sent' as const,
  dispatchT: t,
  writeMode: 'without-response' as const,
  error: null,
});
const skipped = {
  status: 'skipped' as const,
  dispatchT: null,
  writeMode: null,
  error: 'not connected',
};

describe('migrations', () => {
  it('migrates a fresh database to the current version, then is a no-op', () => {
    const raw = new Database(':memory:');
    const db = drizzle(raw, { schema }) as unknown as Db;
    const runner = sqlRunnerFor(db);
    expect(migrate(runner)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(runner.getUserVersion()).toBe(MIGRATIONS.length);
    expect(migrate(runner)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  });

  it('refuses to open a database from a newer app version', () => {
    const { db } = openTestDb();
    const runner = sqlRunnerFor(db);
    runner.setUserVersion(SCHEMA_VERSION + 1);
    expect(() => migrate(runner)).toThrow(/newer than this app/);
    expect(() => runner.setUserVersion(-1)).toThrow(RangeError);
  });

  it('rolls back a failing migration atomically', () => {
    const raw = new Database(':memory:');
    const db = drizzle(raw, { schema }) as unknown as Db;
    const runner = sqlRunnerFor(db);
    const realRun = runner.run;
    let n = 0;
    runner.run = (s) => {
      if (++n === 3) throw new Error('disk full');
      realRun(s);
    };
    expect(() => migrate(runner)).toThrow('disk full');
    expect(runner.getUserVersion()).toBe(0);
    expect(raw.prepare("select count(*) n from sqlite_master where type='table'").get()).toEqual({
      n: 0,
    });
  });

  it('DDL matches the drizzle schema column for column', () => {
    const { raw } = openTestDb();
    for (const table of Object.values(schema)) {
      const cfg = getTableConfig(table);
      const info = raw.prepare(`PRAGMA table_info(${cfg.name})`).all() as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const ddl = Object.fromEntries(info.map((c) => [c.name, c.notnull === 1 || c.pk > 0]));
      const orm = Object.fromEntries(cfg.columns.map((c) => [c.name, c.notNull]));
      expect({ table: cfg.name, cols: ddl }).toEqual({ table: cfg.name, cols: orm });
    }
  });
});

describe('SessionRepository', () => {
  function repo() {
    return new SessionRepository(openTestDb().db);
  }

  it('creates, updates, lists newest first, and finds unfinished sessions', () => {
    const r = repo();
    r.createSession(meta('a', 1000));
    r.createSession(meta('b', 2000));
    expect(r.listSessions().map((s) => s.id)).toEqual(['b', 'a']);
    expect(r.findUnfinished()).toBeUndefined();
    const up = r.updateSession('a', { status: 'running', startedWall: 1500, deviceL: 'dev-L' });
    expect(up).toMatchObject({
      id: 'a',
      status: 'running',
      startedWall: 1500,
      deviceL: 'dev-L',
      deviceR: null,
    });
    expect(r.findUnfinished()?.id).toBe('a');
    expect(() => r.updateSession('zzz', { status: 'stopped' })).toThrow(/not found/);
    expect(r.getSession('nope')).toBeUndefined();
  });

  it('enforces CHECK constraints', () => {
    const r = repo();
    expect(() => r.createSession({ ...meta('x'), plannedSides: 'LL' as never })).toThrow(/CHECK/);
  });

  it('numbers runs per session from 0', () => {
    const r = repo();
    r.createSession(meta('a'));
    r.createSession(meta('b'));
    expect(r.addRun('a', 10, 1000)).toBe(0);
    expect(r.addRun('a', 5, 9000)).toBe(1);
    expect(r.addRun('b', 1, 1)).toBe(0);
    expect(r.getRuns('a').map((x) => [x.run, x.monoAtStart, x.wallAtStart])).toEqual([
      [0, 10, 1000],
      [1, 5, 9000],
    ]);
  });

  it('round-trips sync tokens including per-side outcomes', () => {
    const r = repo();
    r.createSession(meta('s'));
    const tok: SyncTokenRecord = {
      seq: 0,
      token: 0xaa01,
      reason: 'start',
      t: 123.5,
      wall: 99,
      sides: { L: sent(123.5), R: skipped },
      jsDispatchSkewMs: null,
      partial: true,
    };
    r.addToken('s', 0, tok);
    expect(r.getTokens('s')).toEqual([{ ...tok, run: 0 }]);
    expect(() => r.addToken('s', 0, { ...tok, seq: 1, token: 0 })).toThrow(/CHECK/);
    expect(() => r.addToken('s', 0, tok)).toThrow(/UNIQUE|PRIMARY/);
  });

  it('round-trips labels and marks voids', () => {
    const r = repo();
    r.createSession(meta('s'));
    const lab: LabelRecord = {
      seq: 0,
      labelId: 7,
      key: 'fogStart',
      name: 'FoG episode',
      kind: 'start',
      group: 'episode',
      t: 1,
      wall: 2,
      sides: { L: sent(1), R: sent(1) },
      delivered: true,
      voided: false,
      voidsSeq: null,
      autoClosed: false,
    };
    r.addLabel('s', 1, lab);
    r.markLabelVoided('s', 0);
    expect(r.getLabels('s')).toEqual([{ ...lab, run: 1, voided: true }]);
  });

  it('stores notes and connection events in order', () => {
    const r = repo();
    r.createSession(meta('s'));
    r.addNote('s', 0, { seq: 0, t: 5, wall: 6, text: 'tired' });
    expect(r.getNotes('s')).toEqual([{ seq: 0, run: 0, t: 5, wall: 6, text: 'tired' }]);
    expect(r.nextConnectionEventIdx('s')).toBe(0);
    r.addConnectionEvent('s', 0, 0, {
      t: 1,
      wall: 2,
      type: 'ready',
      side: 'L',
      deviceId: 'd',
      detail: 'mode=STREAMING',
    });
    r.addConnectionEvent('s', 0, 1, {
      t: 3,
      wall: 4,
      type: 'adapter_state',
      side: null,
      deviceId: null,
      detail: 'poweredOn',
    });
    expect(r.nextConnectionEventIdx('s')).toBe(2);
    expect(r.getConnectionEvents('s').map((e) => [e.idx, e.type, e.side])).toEqual([
      [0, 'ready', 'L'],
      [1, 'adapter_state', null],
    ]);
  });

  it('deleting a session cascades to all its records', () => {
    const { db, raw } = openTestDb();
    const r = new SessionRepository(db);
    r.createSession(meta('s'));
    r.addRun('s', 0, 0);
    r.addNote('s', 0, { seq: 0, t: 0, wall: 0, text: 'x' });
    r.deleteSession('s');
    for (const t of ['runs', 'notes', 'sync_tokens', 'labels', 'connection_events']) {
      expect(raw.prepare(`select count(*) n from ${t}`).get()).toEqual({ n: 0 });
    }
  });
});
