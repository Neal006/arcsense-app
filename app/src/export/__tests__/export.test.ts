import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { unzipSync, strFromU8 } from 'fflate';

import { MockTransport } from '@/ble/MockTransport';
import { session0007 } from '@/ble/replay';
import { FakeClock } from '@/core/clock';
import { SessionRepository, type SessionRow } from '@/db/SessionRepository';
import { DeviceManager } from '@/services/DeviceManager';
import { SessionRecorder } from '@/services/SessionRecorder';
import { openTestDb } from '@/testing/testDb';

import { csvCell, toCsv } from '../csv';
import { buildExportFiles, buildZip, Timeline } from '../sessionExport';

const GOLDEN_DIR = resolve(__dirname, '../../../../shared/fixtures/app_export_v1');

describe('csv', () => {
  it('quotes only when needed and escapes quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('1');
    expect(csvCell(false)).toBe('0');
    expect(csvCell(1.5)).toBe('1.5');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('writes CRLF rows and rejects ragged rows', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
    expect(() => toCsv(['a', 'b'], [[1]])).toThrow(/1 cells, header has 2/);
  });
});

describe('Timeline', () => {
  const session = { id: 's', startedWall: 10_000 } as SessionRow;
  const runs = [
    { sessionId: 's', run: 0, monoAtStart: 500, wallAtStart: 10_000 },
    { sessionId: 's', run: 1, monoAtStart: 20, wallAtStart: 95_000 },
  ];
  it('maps monotonic times in each run onto the session timeline', () => {
    const tl = new Timeline(session, runs);
    expect(tl.sessionMs(500, 0)).toBe(0);
    expect(tl.sessionMs(1500.12345, 0)).toBe(1000.123);
    expect(tl.sessionMs(20, 1)).toBe(85_000);
    expect(tl.sessionMs(null, 0)).toBeNull();
    expect(() => tl.sessionMs(1, 7)).toThrow(/run 7 missing/);
  });
});

/** A deterministic session: start, labels, a note, a link loss, an app restart, stop. */
async function recordScriptedSession(): Promise<{ repo: SessionRepository; id: string }> {
  const { db } = openTestDb();
  const repo = new SessionRepository(db);
  const devices = () => [
    { id: 'dev-L', side: 'L' as const, mode: 0, strides: session0007() },
    { id: 'dev-R', side: 'R' as const, mode: 0, strides: session0007() },
  ];
  async function app(clock: FakeClock) {
    const transport = new MockTransport(clock, devices());
    const dm = new DeviceManager(transport, clock);
    const p = Promise.all([dm.connect('dev-L', 'L'), dm.connect('dev-R', 'R')]);
    await clock.advanceAsync(100);
    await p;
    const rec = new SessionRecorder({
      dm,
      repo,
      clock,
      appVersion: '0.1.0',
      newId: () => 'P001_golden',
    });
    return { transport, rec };
  }

  const c1 = new FakeClock(1000, Date.UTC(2026, 10, 9, 10, 0, 0));
  const a = await app(c1);
  await a.rec.start({
    subjectCode: 'P001',
    condition: 'Overground, "fast", 10 m',
    operator: 'op',
    notes: '',
    plannedSides: 'LR',
    affectedSide: null,
  });
  await c1.advanceAsync(5000);
  await a.rec.labels().press(1);
  await c1.advanceAsync(30_000);
  await a.rec.labels().press(7);
  await c1.advanceAsync(4000);
  await a.rec.labels().press(8);
  a.rec.labels().addNote('turned, at the wall');
  a.transport.dropLink('dev-R', 'out of range');
  await c1.advanceAsync(30_000);
  // app killed; restarted 15 s later
  const c2 = new FakeClock(200, c1.wallNow() + 15_000);
  const b = await app(c2);
  await b.rec.resume('P001_golden');
  await c2.advanceAsync(10_000);
  await b.rec.labels().press(10);
  await b.rec.labels().voidLast();
  await b.rec.stop();
  return { repo, id: 'P001_golden' };
}

describe('session export', () => {
  it('produces the golden v1 export (shared with the Python reader)', async () => {
    const { repo, id } = await recordScriptedSession();
    const files = buildExportFiles(repo, id);
    expect(Object.keys(files).sort()).toEqual([
      'connection_events.csv',
      'labels.csv',
      'notes.csv',
      'session.json',
      'sync_tokens.csv',
    ]);
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      for (const [name, content] of Object.entries(files))
        writeFileSync(join(GOLDEN_DIR, name), content);
    }
    expect(existsSync(GOLDEN_DIR)).toBe(true);
    for (const [name, content] of Object.entries(files)) {
      expect({ name, content }).toEqual({
        name,
        content: readFileSync(join(GOLDEN_DIR, name), 'utf8'),
      });
    }
  });

  it('places events from both runs on one continuous timeline', async () => {
    const { repo, id } = await recordScriptedSession();
    const files = buildExportFiles(repo, id);
    const rows = files['sync_tokens.csv']!.trim()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(','));
    const ms = rows.map((r) => Number(r[5]));
    expect(ms[0]).toBe(0);
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]!);
    const runOfFirstRun1 = rows.find((r) => r[1] === '1')!;
    // resumed after 69 s of recording + 15 s dead + 100 ms reconnecting (both ankles in parallel)
    expect(Number(runOfFirstRun1[5])).toBe(69_000 + 15_000 + 100);
    expect(runOfFirstRun1[4]).toBe('resume');
    expect(rows.map((r) => r[3])).toEqual(['0xAA01', '0xAA02', '0xAA03', '0xAA04', '0xAA05']);
  });

  it('zips under a session folder and round-trips byte for byte, reproducibly', async () => {
    const { repo, id } = await recordScriptedSession();
    const files = buildExportFiles(repo, id);
    const zip = buildZip(id, files);
    const back = unzipSync(zip);
    expect(Object.keys(back).sort()).toEqual(
      Object.keys(files)
        .map((f) => `${id}/${f}`)
        .sort(),
    );
    expect(strFromU8(back[`${id}/labels.csv`]!)).toBe(files['labels.csv']);
    expect(buildZip(id, files)).toEqual(zip);
  });

  it('rejects unknown sessions', () => {
    const repo = new SessionRepository(openTestDb().db);
    expect(() => buildExportFiles(repo, 'nope')).toThrow(/not found/);
  });
});
