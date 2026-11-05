import { MockTransport } from '@/ble/MockTransport';
import { session0007 } from '@/ble/replay';
import { FakeClock } from '@/core/clock';
import { SessionRepository } from '@/db/SessionRepository';
import { FEATURE_SPEC_HASH } from '@/shared/generated/features';
import { openTestDb } from '@/testing/testDb';

import { DeviceManager } from '../DeviceManager';
import {
  defaultSessionId,
  SessionError,
  SessionRecorder,
  validateMeta,
  type SessionMetaInput,
} from '../SessionRecorder';

const META: SessionMetaInput = {
  subjectCode: 'P001',
  condition: 'Overground walk',
  operator: 'op',
  notes: '',
  plannedSides: 'LR',
  affectedSide: null,
};

async function rig(
  opts: { connect?: ('L' | 'R')[]; repo?: SessionRepository; clock?: FakeClock } = {},
) {
  const clock = opts.clock ?? new FakeClock(0, Date.UTC(2026, 10, 9, 10, 0, 0));
  const transport = new MockTransport(clock, [
    { id: 'dev-L', side: 'L', mode: 0, strides: session0007() },
    { id: 'dev-R', side: 'R', mode: 0, strides: session0007() },
  ]);
  const dm = new DeviceManager(transport, clock);
  const repo = opts.repo ?? new SessionRepository(openTestDb().db);
  for (const side of opts.connect ?? ['L', 'R']) {
    const p = dm.connect(side === 'L' ? 'dev-L' : 'dev-R', side);
    await clock.advanceAsync(100);
    await p;
  }
  let n = 0;
  const rec = new SessionRecorder({ dm, repo, clock, appVersion: '0.1.0', newId: () => `S${++n}` });
  return { clock, transport, dm, repo, rec };
}

describe('validateMeta', () => {
  it('requires a pseudonymous subject code, condition and operator', () => {
    expect(validateMeta(META)).toEqual([]);
    expect(validateMeta({ ...META, subjectCode: 'John Smith' })[0]).toMatch(/Subject code/);
    expect(validateMeta({ ...META, subjectCode: '' })).toHaveLength(1);
    expect(validateMeta({ ...META, condition: ' ', operator: '' })).toHaveLength(2);
  });

  it('builds sortable, unique-enough session ids', () => {
    const id = defaultSessionId('P001', Date.UTC(2026, 10, 9, 8, 5, 3));
    expect(id).toMatch(/^P001_20261109-080503Z_[0-9a-f]{4}$/);
  });
});

describe('SessionRecorder', () => {
  it('refuses to start without the planned ankles connected', async () => {
    const { rec } = await rig({ connect: ['L'] });
    expect(rec.missingSides('LR')).toEqual(['R']);
    await expect(rec.start(META)).rejects.toThrow('Connect R before starting.');
    await expect(rec.start({ ...META, subjectCode: 'x y' })).rejects.toThrow(SessionError);
    expect(rec.state()).toBe('idle');
    const row = await rec.start({ ...META, plannedSides: 'L' });
    expect(row.plannedSides).toBe('L');
  });

  it('start persists metadata, run 0, session start value and the first token', async () => {
    const { rec, repo } = await rig();
    const states: string[] = [];
    rec.on('state', (s) => states.push(s));
    const row = await rec.start(META);
    expect(states).toEqual(['starting', 'running']);
    expect(row).toMatchObject({
      id: 'S1',
      status: 'running',
      subjectCode: 'P001',
      deviceL: 'dev-L',
      deviceR: 'dev-R',
      modeL: 'DATA_COLLECTION',
      featureSpecHash: FEATURE_SPEC_HASH,
      gattSpecVersion: '1.0.0',
    });
    expect(row.sessionStartValue).toBe(rec.sync().getSessionStart()!.value);
    expect(repo.getRuns('S1')).toHaveLength(1);
    expect(repo.getTokens('S1').map((t) => [t.seq, t.token, t.reason, t.run])).toEqual([
      [0, 0xaa01, 'start', 0],
    ]);
    expect(repo.getSession('S1')!.lastToken).toBe(0xaa01);
    await expect(rec.start(META)).rejects.toThrow(/cannot start while running/);
  });

  it('writes through tokens, labels, voids, notes and connection events', async () => {
    const { rec, repo, clock, transport } = await rig();
    await rec.start(META);
    await rec.labels().press(1);
    await rec.labels().press(10);
    await rec.labels().voidLast();
    rec.labels().addNote('fatigue');
    await clock.advanceAsync(120_000);
    transport.dropLink('dev-R');
    await clock.advanceAsync(2_000);

    expect(repo.getTokens('S1').map((t) => t.reason)).toEqual([
      'start',
      'periodic',
      'periodic',
      'resync',
    ]);
    expect(repo.getSession('S1')!.lastToken).toBe(0xaa04);
    const labels = repo.getLabels('S1');
    expect(labels.map((l) => [l.labelId, l.voided])).toEqual([
      [1, false],
      [10, true],
      [99, false],
    ]);
    expect(repo.getNotes('S1').map((n) => n.text)).toEqual(['fatigue']);
    const types = repo.getConnectionEvents('S1').map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['link_lost', 'reconnect_scheduled', 'ready']));
  });

  it('stop closes episodes, sends the final token and summarises', async () => {
    const { rec, repo, clock } = await rig();
    await rec.start(META);
    await rec.labels().press(1);
    await rec.labels().press(7);
    await clock.advanceAsync(90_000);
    const summary = await rec.stop();
    expect(summary).toMatchObject({
      sessionId: 'S1',
      durationMs: 90_000,
      tokens: 3, // start, one periodic, stop
      partialTokens: 0,
      labels: 4, // 2 starts + 2 auto-closed ends
      autoClosedEpisodes: 2,
      voidedLabels: 0,
      linkLosses: 0,
    });
    expect(repo.getSession('S1')).toMatchObject({ status: 'stopped' });
    expect(repo.getTokens('S1').at(-1)!.reason).toBe('stop');
    expect(rec.state()).toBe('idle');
    expect(() => rec.labels()).toThrow(/no active session/);
    expect(() => rec.sync()).toThrow(/no active session/);
    await expect(rec.stop()).rejects.toThrow(/cannot stop while idle/);
    await clock.advanceAsync(120_000);
    expect(repo.getTokens('S1')).toHaveLength(3); // nothing after stop
  });

  it('recovers an unfinished session after an app restart', async () => {
    const { db } = openTestDb();
    const repo = new SessionRepository(db);
    const first = await rig({ repo });
    await first.rec.start(META);
    await first.rec.labels().press(3); // shuffling trial open
    await first.clock.advanceAsync(65_000);
    // app is killed here: no stop()

    const clock2 = new FakeClock(500, first.clock.wallNow() + 20_000); // new process, new monotonic base
    const second = await rig({ repo, clock: clock2 });
    const unfinished = second.rec.findUnfinished();
    expect(unfinished?.id).toBe('S1');
    await second.rec.resume('S1');
    expect(repo.getRuns('S1').map((r) => r.run)).toEqual([0, 1]);
    expect(second.rec.labels().isOpen(3)).toBe(true);
    const tokens = repo.getTokens('S1');
    expect(tokens.map((t) => [t.seq, t.token, t.run])).toEqual([
      [0, 0xaa01, 0],
      [1, 0xaa02, 0],
      [2, 0xaa03, 1],
    ]);
    // Session clock bridges the restart using wall time: 65 s recorded before the
    // kill, 20 s while the app was dead, 200 ms reconnecting both ankles (100 ms each).
    expect(second.rec.elapsedMs()).toBe(65_000 + 20_000 + 200);
    await second.rec.labels().press(4);
    expect(repo.getLabels('S1').map((l) => [l.seq, l.labelId, l.run])).toEqual([
      [0, 3, 0],
      [1, 4, 1],
    ]);
    const summary = await second.rec.stop();
    expect(summary.tokens).toBe(4);
  });

  it('abandons an unfinished session instead of resuming', async () => {
    const { db } = openTestDb();
    const repo = new SessionRepository(db);
    const first = await rig({ repo });
    await first.rec.start(META);
    expect(() => first.rec.abandon('S1')).toThrow(/active in this app run/);
    const second = await rig({ repo });
    second.rec.abandon('S1');
    expect(repo.getSession('S1')!.status).toBe('aborted');
    expect(() => second.rec.abandon('S1')).toThrow(/not unfinished/);
    await expect(second.rec.resume('S1')).rejects.toThrow(/not resumable/);
  });

  it('marks the session aborted if starting fails part-way', async () => {
    const { rec, repo } = await rig();
    jest.spyOn(repo, 'addRun').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(rec.start(META)).rejects.toThrow('disk full');
    expect(repo.getSession('S1')!.status).toBe('aborted');
    expect(rec.state()).toBe('idle');
    expect(rec.current()).toBeNull();
  });

  it('stop still closes the session when the final writes fail, then re-raises', async () => {
    const { rec, repo } = await rig();
    await rec.start(META);
    jest.spyOn(rec.sync(), 'stop').mockRejectedValue(new Error('BLE stack error'));
    await expect(rec.stop()).rejects.toThrow('BLE stack error');
    expect(repo.getSession('S1')!.status).toBe('stopped');
    expect(rec.state()).toBe('idle');
  });

  it('a failed resume leaves the recorder idle and the session resumable', async () => {
    const { db } = openTestDb();
    const repo = new SessionRepository(db);
    const first = await rig({ repo });
    await first.rec.start(META);
    const second = await rig({ repo });
    jest.spyOn(repo, 'getLabels').mockImplementation(() => {
      throw new Error('corrupt');
    });
    await expect(second.rec.resume('S1')).rejects.toThrow('corrupt');
    expect(second.rec.state()).toBe('idle');
    expect(repo.getSession('S1')!.status).toBe('running');
  });

  it('elapsed time is zero when idle and summarize rejects unknown sessions', async () => {
    const { rec } = await rig();
    expect(rec.elapsedMs()).toBe(0);
    expect(() => rec.summarize('nope')).toThrow(/not found/);
  });
});
