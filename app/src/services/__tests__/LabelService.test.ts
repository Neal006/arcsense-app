import { decodeValue } from '@/ble/codec';
import { MockTransport } from '@/ble/MockTransport';
import { session0007 } from '@/ble/replay';
import { FakeClock } from '@/core/clock';
import { VOID_LABEL_ID } from '@/shared/generated/labels';

import { DeviceManager } from '../DeviceManager';
import {
  LabelError,
  LabelService,
  labelDef,
  openEpisodes,
  type LabelRecord,
} from '../LabelService';

const NORMAL = 1;
const NORMAL_END = 2;
const SHUFFLE = 3;
const FOG = 7;
const FOG_END = 8;
const TURN = 10;

async function rig(connect = true) {
  const clock = new FakeClock();
  const transport = new MockTransport(clock, [
    { id: 'dev-L', side: 'L', mode: 0, strides: session0007() },
    { id: 'dev-R', side: 'R', mode: 0, strides: session0007() },
  ]);
  const dm = new DeviceManager(transport, clock);
  if (connect) {
    const p = Promise.all([dm.connect('dev-L', 'L'), dm.connect('dev-R', 'R')]);
    await clock.advanceAsync(100);
    await p;
  }
  return { clock, transport, dm, labels: new LabelService(dm, clock) };
}

const labelWrites = (t: MockTransport) =>
  t.writes
    .filter((w) => w.key === 'labelMarker')
    .map((w) => [w.deviceId, decodeValue('u16', w.value)]);

describe('LabelService', () => {
  it('catalog hides the VOID control and keeps catalogue order', async () => {
    const { labels } = await rig();
    const ids = labels.catalog().map((l) => l.id);
    expect(ids).not.toContain(VOID_LABEL_ID);
    expect(ids.slice(0, 2)).toEqual([NORMAL, NORMAL_END]);
  });

  it('writes the label id to both ankles and records the tap time', async () => {
    const { clock, transport, labels } = await rig();
    clock.advance(5000);
    const rec = await labels.press(TURN);
    expect(labelWrites(transport)).toEqual([
      ['dev-L', TURN],
      ['dev-R', TURN],
    ]);
    expect(rec).toMatchObject({
      seq: 0,
      labelId: TURN,
      key: 'turn',
      kind: 'instant',
      t: 5100,
      delivered: true,
      voided: false,
    });
    expect(rec.sides.L.writeMode).toBe('without-response');
  });

  it('runs an episode: start, refuse double start, end, refuse double end', async () => {
    const { labels } = await rig();
    await labels.press(FOG);
    expect(labels.isOpen(FOG)).toBe(true);
    expect(labels.availability(FOG)).toEqual({
      enabled: false,
      reason: 'FoG episode is already running',
    });
    await expect(labels.press(FOG)).rejects.toThrow(LabelError);
    await labels.press(FOG_END);
    expect(labels.isOpen(FOG)).toBe(false);
    expect(labels.availability(FOG_END)).toEqual({
      enabled: false,
      reason: 'FoG episode is not running',
    });
    await expect(labels.press(FOG_END)).rejects.toThrow(/not running/);
    expect(labels.getRecords()).toHaveLength(2);
  });

  it('keeps trials mutually exclusive but lets FoG overlap a trial', async () => {
    const { labels } = await rig();
    await labels.press(NORMAL);
    expect(labels.availability(SHUFFLE)).toEqual({
      enabled: false,
      reason: 'End "Normal walk" first',
    });
    await expect(labels.press(SHUFFLE)).rejects.toThrow(/End "Normal walk" first/);
    await labels.press(FOG);
    expect(
      labels
        .open()
        .map((r) => r.labelId)
        .sort(),
    ).toEqual([NORMAL, FOG]);
  });

  it('toggleEpisode presses start or end as appropriate', async () => {
    const { labels } = await rig();
    expect((await labels.toggleEpisode(FOG)).labelId).toBe(FOG);
    expect((await labels.toggleEpisode(FOG)).labelId).toBe(FOG_END);
    await expect(labels.toggleEpisode(TURN)).rejects.toThrow(/not an episode start/);
  });

  it('serialises rapid double taps: the second start is rejected', async () => {
    const { labels } = await rig();
    const results = await Promise.allSettled([labels.press(FOG), labels.press(FOG)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('void flags the last label, writes VOID, and reopens/closes episodes accordingly', async () => {
    const { transport, labels } = await rig();
    await labels.press(FOG);
    await labels.press(FOG_END);
    const v = await labels.voidLast();
    expect(v).toMatchObject({ labelId: VOID_LABEL_ID, kind: 'void', voidsSeq: 1 });
    expect(labels.getRecords()[1]!.voided).toBe(true);
    expect(labels.isOpen(FOG)).toBe(true); // voiding the end reopens the episode
    await labels.press(VOID_LABEL_ID); // voids the start
    expect(labels.isOpen(FOG)).toBe(false);
    expect(labelWrites(transport).filter(([, id]) => id === VOID_LABEL_ID)).toHaveLength(4);
    await expect(labels.press(VOID_LABEL_ID)).rejects.toThrow(/Nothing to void/);
    expect(labels.availability(VOID_LABEL_ID)).toEqual({
      enabled: false,
      reason: 'Nothing to void',
    });
  });

  it('closeAll auto-closes open episodes innermost first', async () => {
    const { labels } = await rig();
    await labels.press(NORMAL);
    await labels.press(FOG);
    const closed = await labels.closeAll();
    expect(closed.map((r) => r.labelId)).toEqual([FOG_END, NORMAL_END]);
    expect(closed.every((r) => r.autoClosed)).toBe(true);
    expect(labels.open()).toEqual([]);
    expect(await labels.closeAll()).toEqual([]);
  });

  it('records labels even when no ankle is connected (phone log is authoritative)', async () => {
    const { labels } = await rig(false);
    const rec = await labels.press(TURN);
    expect(rec.delivered).toBe(false);
    expect(rec.sides.L.status).toBe('skipped');
    expect(labels.getRecords()).toHaveLength(1);
  });

  it('adds trimmed timestamped notes and rejects empty ones', async () => {
    const { clock, labels } = await rig();
    const notes: string[] = [];
    labels.on('note', (n) => notes.push(n.text));
    clock.advance(42);
    expect(labels.addNote('  patient tired  ')).toMatchObject({
      seq: 0,
      t: 142,
      text: 'patient tired',
    });
    expect(() => labels.addNote('   ')).toThrow(/empty/);
    expect(notes).toEqual(['patient tired']);
    expect(labels.getNotes()).toHaveLength(1);
  });

  it('restores persisted state for crash recovery', async () => {
    const a = await rig();
    await a.labels.press(NORMAL);
    a.labels.addNote('x');
    const b = await rig();
    b.labels.restore(a.labels.getRecords(), a.labels.getNotes());
    expect(b.labels.isOpen(NORMAL)).toBe(true);
    expect(() => b.labels.restore([], [])).toThrow(/used service/);
    const next = await b.labels.press(NORMAL_END);
    expect(next.seq).toBe(1);
  });

  it('rejects unknown label ids', async () => {
    const { labels } = await rig();
    expect(() => labelDef(12345)).toThrow(/unknown label id/);
    await expect(labels.press(12345)).rejects.toThrow(LabelError);
  });

  it('openEpisodes ignores voided records and void entries', () => {
    const base = {
      t: 0,
      wall: 0,
      sides: {} as LabelRecord['sides'],
      delivered: true,
      voidsSeq: null,
      autoClosed: false,
      name: '',
      group: 'episode' as const,
    };
    const recs: LabelRecord[] = [
      { ...base, seq: 0, labelId: FOG, key: 'fogStart', kind: 'start', voided: true },
      {
        ...base,
        seq: 1,
        labelId: VOID_LABEL_ID,
        key: 'void',
        kind: 'void',
        voided: false,
        group: 'control' as never,
      },
    ];
    expect(openEpisodes(recs)).toEqual([]);
  });
});
