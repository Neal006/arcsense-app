/**
 * Session export bundle (functionalities F47 marker files, F49).
 *
 * Every event is placed on one session timeline, `session_ms`: milliseconds
 * since the session started. Within an app run it is derived from the
 * monotonic clock; across an app restart the runs are bridged by wall time
 * (see db/schema.ts). The ML pipeline reads these files unchanged
 * (ml/arcsense_ml/app_export.py).
 */
import { strToU8, zipSync } from 'fflate';

import type { RunRow, SessionRepository, SessionRow } from '@/db/SessionRepository';
import type { SideWrite } from '@/services/bilateralWrite';

import { toCsv, type Cell } from './csv';

export const EXPORT_FORMAT = 'arcsense-session-export';
export const EXPORT_VERSION = 1;

export class Timeline {
  private readonly byRun = new Map<number, RunRow>();

  constructor(
    private readonly session: SessionRow,
    runs: readonly RunRow[],
  ) {
    for (const r of runs) this.byRun.set(r.run, r);
  }

  /** Milliseconds since session start for monotonic time `t` captured in `run`. */
  sessionMs(t: number | null, run: number): number | null {
    if (t === null) return null;
    const r = this.byRun.get(run);
    if (!r) throw new Error(`run ${run} missing for session ${this.session.id}`);
    const started = this.session.startedWall ?? r.wallAtStart;
    return round3(t - r.monoAtStart + (r.wallAtStart - started));
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function iso(wall: number): string {
  return new Date(wall).toISOString();
}

function sideCells(tl: Timeline, w: SideWrite, run: number): Cell[] {
  return [w.status, tl.sessionMs(w.dispatchT, run), w.writeMode, w.error];
}

const SIDE_HEADER = (p: 'l' | 'r') => [
  `${p}_status`,
  `${p}_dispatch_session_ms`,
  `${p}_write_mode`,
  `${p}_error`,
];

export function buildExportFiles(
  repo: SessionRepository,
  sessionId: string,
): Record<string, string> {
  const session = repo.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const runs = repo.getRuns(sessionId);
  const tl = new Timeline(session, runs);

  const tokens = repo.getTokens(sessionId);
  const labels = repo.getLabels(sessionId);
  const notes = repo.getNotes(sessionId);
  const events = repo.getConnectionEvents(sessionId);

  const syncCsv = toCsv(
    [
      'seq',
      'run',
      'token',
      'token_hex',
      'reason',
      'session_ms',
      'wall_iso',
      ...SIDE_HEADER('l'),
      ...SIDE_HEADER('r'),
      'js_dispatch_skew_ms',
      'partial',
    ],
    tokens.map((x) => [
      x.seq,
      x.run,
      x.token,
      `0x${x.token.toString(16).toUpperCase().padStart(4, '0')}`,
      x.reason,
      tl.sessionMs(x.t, x.run),
      iso(x.wall),
      ...sideCells(tl, x.sides.L, x.run),
      ...sideCells(tl, x.sides.R, x.run),
      x.jsDispatchSkewMs,
      x.partial,
    ]),
  );

  const labelsCsv = toCsv(
    [
      'seq',
      'run',
      'label_id',
      'key',
      'name',
      'kind',
      'group',
      'session_ms',
      'wall_iso',
      ...SIDE_HEADER('l'),
      ...SIDE_HEADER('r'),
      'delivered',
      'voided',
      'voids_seq',
      'auto_closed',
    ],
    labels.map((x) => [
      x.seq,
      x.run,
      x.labelId,
      x.key,
      x.name,
      x.kind,
      x.group,
      tl.sessionMs(x.t, x.run),
      iso(x.wall),
      ...sideCells(tl, x.sides.L, x.run),
      ...sideCells(tl, x.sides.R, x.run),
      x.delivered,
      x.voided,
      x.voidsSeq,
      x.autoClosed,
    ]),
  );

  const notesCsv = toCsv(
    ['seq', 'run', 'session_ms', 'wall_iso', 'text'],
    notes.map((n) => [n.seq, n.run, tl.sessionMs(n.t, n.run), iso(n.wall), n.text]),
  );

  const eventsCsv = toCsv(
    ['idx', 'run', 'session_ms', 'wall_iso', 'type', 'side', 'device_id', 'detail'],
    events.map((e) => [
      e.idx,
      e.run,
      tl.sessionMs(e.t, e.run),
      iso(e.wall),
      e.type,
      e.side,
      e.deviceId,
      e.detail,
    ]),
  );

  const meta = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    timebase:
      'session_ms = ms since session start; monotonic within a run, runs bridged by wall time',
    session,
    runs,
    counts: {
      syncTokens: tokens.length,
      labels: labels.length,
      notes: notes.length,
      connectionEvents: events.length,
    },
  };

  return {
    'session.json': JSON.stringify(meta, null, 2) + '\n',
    'sync_tokens.csv': syncCsv,
    'labels.csv': labelsCsv,
    'notes.csv': notesCsv,
    'connection_events.csv': eventsCsv,
  };
}

/** Zip the files under a folder named after the session. */
export function buildZip(sessionId: string, files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files))
    entries[`${sessionId}/${name}`] = strToU8(content);
  // fixed mtime keeps archives reproducible (same session -> same bytes)
  return zipSync(entries, { level: 6, mtime: new Date(Date.UTC(2020, 0, 1)) });
}
