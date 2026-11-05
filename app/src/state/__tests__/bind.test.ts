import { createStore } from 'zustand/vanilla';

import { FakeClock } from '@/core/clock';
import { SessionRepository } from '@/db/SessionRepository';
import { openTestDb } from '@/testing/testDb';

import { bindServices } from '../bind';
import { createServices, replayTransport } from '../services';
import { EVENT_LOG_LIMIT, initialState, type AppState } from '../store';

jest.mock('@/db/open', () => ({ openRepository: () => null }));
jest.mock('@/ble/PlxTransport', () => ({ PlxTransport: jest.fn(() => ({ kind: 'plx' })) }));

function setup() {
  const clock = new FakeClock();
  const repo = new SessionRepository(openTestDb().db);
  const services = createServices('replay', '0.1.0', { clock, repo });
  const store = createStore<AppState>()(() => initialState());
  const unbind = bindServices(services.dm, services.recorder, store);
  return { clock, services, store, unbind };
}

const META = {
  subjectCode: 'P001',
  condition: 'walk',
  operator: 'op',
  notes: '',
  plannedSides: 'LR' as const,
  affectedSide: null,
};

describe('createServices', () => {
  it('builds the real BLE transport in ble mode', () => {
    const repo = new SessionRepository(openTestDb().db);
    const s = createServices('ble', '0.1.0', { repo });
    expect(s.transport).toEqual({ kind: 'plx' });
    expect(s.mode).toBe('ble');
  });

  it('replay transport exposes both virtual ankles in STREAMING mode', () => {
    const t = replayTransport(new FakeClock());
    const seen: string[] = [];
    t.startScan(
      null,
      (r) => seen.push(r.name!),
      () => undefined,
    );
    t.stopScan();
    expect(seen).toEqual([]); // first results arrive on the next tick
  });
});

describe('bindServices', () => {
  it('mirrors adapter, scan results and link states', async () => {
    const { clock, services, store } = setup();
    await services.dm.init();
    expect(store.getState().adapter).toBe('poweredOn');
    services.dm.startScan();
    await clock.advanceAsync(0);
    expect(store.getState().scanning).toBe(true);
    expect(
      store
        .getState()
        .discovered.map((d) => d.name)
        .sort(),
    ).toEqual(['ArcSense-L', 'ArcSense-R']);
    const p = services.dm.connectBoth();
    await clock.advanceAsync(200);
    await p;
    expect(store.getState().links.L.state).toBe('ready');
    expect(store.getState().links.R.mode).toBe('STREAMING');
    expect(store.getState().scanning).toBe(false);
    expect(store.getState().events.some((e) => e.type === 'ready')).toBe(true);
  });

  it('mirrors a session: tokens, labels, open episodes, notes; clears on stop', async () => {
    const { clock, services, store } = setup();
    services.dm.startScan();
    await clock.advanceAsync(0);
    const p = services.dm.connectBoth();
    await clock.advanceAsync(200);
    await p;
    await services.recorder.start(META);
    let s = store.getState();
    expect(s.recorder).toBe('running');
    expect(s.session?.subjectCode).toBe('P001');
    expect(s.tokens).toHaveLength(1);
    await services.recorder.labels().press(7);
    services.recorder.labels().addNote('n');
    await clock.advanceAsync(60_000);
    s = store.getState();
    expect(s.openEpisodeIds).toEqual([7]);
    expect(s.labels).toHaveLength(1);
    expect(s.notes).toHaveLength(1);
    expect(s.tokens).toHaveLength(2);
    await services.recorder.labels().voidLast();
    expect(store.getState().openEpisodeIds).toEqual([]);
    await services.recorder.stop();
    s = store.getState();
    expect(s.recorder).toBe('idle');
    expect(s.session).toBeNull();
    expect(s.tokens).toEqual([]);
    expect(s.labels).toEqual([]);
  });

  it('caps the event log and unbinds cleanly', async () => {
    const { clock, services, store, unbind } = setup();
    for (let i = 0; i < EVENT_LOG_LIMIT + 20; i++) {
      services.dm.startScan();
      services.dm.stopScan();
    }
    await clock.advanceAsync(0);
    expect(store.getState().events).toHaveLength(EVENT_LOG_LIMIT);
    unbind();
    services.dm.startScan();
    expect(store.getState().scanning).toBe(false);
  });
});
