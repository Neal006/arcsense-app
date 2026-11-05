/** Real service graph (replay transport, FakeClock, in-memory DB) for screen tests. */
import { act } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { FakeClock } from '@/core/clock';
import { SessionRepository } from '@/db/SessionRepository';
import { bindServices } from '@/state/bind';
import { ServicesProvider } from '@/state/ServicesContext';
import { createServices, type Services } from '@/state/services';
import { initialState, useAppStore } from '@/state/store';

import { openTestDb } from './testDb';

export function makeHarness(opts: { repo?: SessionRepository; mode?: 'replay' | 'ble' } = {}) {
  useAppStore.setState(initialState());
  const clock = new FakeClock();
  const repo = opts.repo ?? new SessionRepository(openTestDb().db);
  const services: Services = createServices('replay', '0.1.0', { clock, repo });
  if (opts.mode === 'ble') (services as { mode: string }).mode = 'ble';
  const unbind = bindServices(services.dm, services.recorder);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesProvider services={services}>{children}</ServicesProvider>
  );
  const advance = (ms: number) => act(() => clock.advanceAsync(ms));
  const connectBoth = async () => {
    services.dm.startScan();
    await advance(0);
    const p = services.dm.connectBoth();
    await advance(200);
    await act(() => p.then(() => undefined));
  };
  return { clock, repo, services, unbind, wrapper, advance, connectBoth };
}
