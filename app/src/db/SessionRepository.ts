/**
 * Persistence for sessions and everything recorded during them. Works on any
 * synchronous drizzle SQLite database: expo-sqlite in the app, better-sqlite3
 * in tests.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { ConnectionEvent } from '@/services/DeviceManager';
import type { SideWrite } from '@/services/bilateralWrite';
import type { LabelRecord, NoteRecord } from '@/services/LabelService';
import type { SyncTokenRecord } from '@/services/SyncService';

import { connectionEvents, labels, notes, runs, schema, sessions, syncTokens } from './schema';
import type { SqlRunner } from './migrations';

export type Db = BaseSQLiteDatabase<'sync', unknown, typeof schema>;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type SessionStatus = SessionRow['status'];

/** A record as stored: the domain record plus the run it was captured in. */
export type Stored<T> = T & { run: number };

function sideCols(prefix: 'l' | 'r', w: SideWrite) {
  return {
    [`${prefix}Status`]: w.status,
    [`${prefix}DispatchT`]: w.dispatchT,
    [`${prefix}WriteMode`]: w.writeMode,
    [`${prefix}Error`]: w.error,
  } as Record<string, unknown>;
}

function sideFrom(row: Record<string, unknown>, prefix: 'l' | 'r'): SideWrite {
  return {
    status: row[`${prefix}Status`] as SideWrite['status'],
    dispatchT: (row[`${prefix}DispatchT`] as number | null) ?? null,
    writeMode: (row[`${prefix}WriteMode`] as SideWrite['writeMode']) ?? null,
    error: (row[`${prefix}Error`] as string | null) ?? null,
  };
}

export function sqlRunnerFor(db: Db): SqlRunner {
  return {
    run: (s) => {
      db.run(sql.raw(s));
    },
    getUserVersion: () => {
      const row = db.get<{ user_version: number }>(sql.raw('PRAGMA user_version'));
      return row?.user_version ?? 0;
    },
    setUserVersion: (v) => {
      if (!Number.isInteger(v) || v < 0) throw new RangeError(`bad schema version ${v}`);
      db.run(sql.raw(`PRAGMA user_version = ${v}`));
    },
    transaction: (fn) => {
      db.transaction(() => fn());
    },
  };
}

export class SessionRepository {
  constructor(private readonly db: Db) {}

  // ---- sessions ------------------------------------------------------------

  createSession(row: NewSession): SessionRow {
    return this.db.insert(sessions).values(row).returning().get();
  }

  updateSession(id: string, patch: Partial<Omit<NewSession, 'id'>>): SessionRow {
    const row = this.db.update(sessions).set(patch).where(eq(sessions.id, id)).returning().get();
    if (!row) throw new Error(`session ${id} not found`);
    return row;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  listSessions(): SessionRow[] {
    return this.db.select().from(sessions).orderBy(desc(sessions.createdWall)).all();
  }

  /** A session left 'running' means the app died mid-session (F28). */
  findUnfinished(): SessionRow | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.status, 'running'))
      .orderBy(desc(sessions.createdWall))
      .get();
  }

  deleteSession(id: string): void {
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  // ---- runs ------------------------------------------------------------------

  addRun(sessionId: string, monoAtStart: number, wallAtStart: number): number {
    const last = this.db
      .select({ run: runs.run })
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(desc(runs.run))
      .get();
    const run = last ? last.run + 1 : 0;
    this.db.insert(runs).values({ sessionId, run, monoAtStart, wallAtStart }).run();
    return run;
  }

  getRuns(sessionId: string): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(asc(runs.run))
      .all();
  }

  // ---- sync tokens -------------------------------------------------------------

  addToken(sessionId: string, run: number, r: SyncTokenRecord): void {
    this.db
      .insert(syncTokens)
      .values({
        sessionId,
        run,
        seq: r.seq,
        token: r.token,
        reason: r.reason,
        t: r.t,
        wall: r.wall,
        ...(sideCols('l', r.sides.L) as object),
        ...(sideCols('r', r.sides.R) as object),
        jsDispatchSkewMs: r.jsDispatchSkewMs,
        partial: r.partial,
      } as typeof syncTokens.$inferInsert)
      .run();
  }

  getTokens(sessionId: string): Stored<SyncTokenRecord>[] {
    return this.db
      .select()
      .from(syncTokens)
      .where(eq(syncTokens.sessionId, sessionId))
      .orderBy(asc(syncTokens.seq))
      .all()
      .map((row) => ({
        seq: row.seq,
        run: row.run,
        token: row.token,
        reason: row.reason,
        t: row.t,
        wall: row.wall,
        sides: { L: sideFrom(row, 'l'), R: sideFrom(row, 'r') },
        jsDispatchSkewMs: row.jsDispatchSkewMs,
        partial: row.partial,
      }));
  }

  // ---- labels ----------------------------------------------------------------------

  addLabel(sessionId: string, run: number, r: LabelRecord): void {
    this.db
      .insert(labels)
      .values({
        sessionId,
        run,
        seq: r.seq,
        labelId: r.labelId,
        key: r.key,
        name: r.name,
        kind: r.kind,
        group: r.group,
        t: r.t,
        wall: r.wall,
        ...(sideCols('l', r.sides.L) as object),
        ...(sideCols('r', r.sides.R) as object),
        delivered: r.delivered,
        voided: r.voided,
        voidsSeq: r.voidsSeq,
        autoClosed: r.autoClosed,
      } as typeof labels.$inferInsert)
      .run();
  }

  markLabelVoided(sessionId: string, seq: number): void {
    this.db
      .update(labels)
      .set({ voided: true })
      .where(and(eq(labels.sessionId, sessionId), eq(labels.seq, seq)))
      .run();
  }

  getLabels(sessionId: string): Stored<LabelRecord>[] {
    return this.db
      .select()
      .from(labels)
      .where(eq(labels.sessionId, sessionId))
      .orderBy(asc(labels.seq))
      .all()
      .map((row) => ({
        seq: row.seq,
        run: row.run,
        labelId: row.labelId,
        key: row.key,
        name: row.name,
        kind: row.kind,
        group: row.group as LabelRecord['group'],
        t: row.t,
        wall: row.wall,
        sides: { L: sideFrom(row, 'l'), R: sideFrom(row, 'r') },
        delivered: row.delivered,
        voided: row.voided,
        voidsSeq: row.voidsSeq,
        autoClosed: row.autoClosed,
      }));
  }

  // ---- notes and connection events -----------------------------------------------------

  addNote(sessionId: string, run: number, n: NoteRecord): void {
    this.db
      .insert(notes)
      .values({ sessionId, run, ...n })
      .run();
  }

  getNotes(sessionId: string): Stored<NoteRecord>[] {
    return this.db
      .select({ seq: notes.seq, run: notes.run, t: notes.t, wall: notes.wall, text: notes.text })
      .from(notes)
      .where(eq(notes.sessionId, sessionId))
      .orderBy(asc(notes.seq))
      .all();
  }

  addConnectionEvent(sessionId: string, run: number, idx: number, e: ConnectionEvent): void {
    this.db
      .insert(connectionEvents)
      .values({ sessionId, run, idx, ...e })
      .run();
  }

  getConnectionEvents(sessionId: string): Stored<ConnectionEvent & { idx: number }>[] {
    return this.db
      .select()
      .from(connectionEvents)
      .where(eq(connectionEvents.sessionId, sessionId))
      .orderBy(asc(connectionEvents.idx))
      .all()
      .map(({ sessionId: _s, ...rest }) => ({
        ...rest,
        type: rest.type as ConnectionEvent['type'],
      }));
  }

  nextConnectionEventIdx(sessionId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(connectionEvents)
      .where(eq(connectionEvents.sessionId, sessionId))
      .get();
    return row?.n ?? 0;
  }
}
