/**
 * Composition root: builds the service graph once per app process.
 * `replay` mode swaps the BLE stack for virtual ankles replaying session 0007,
 * so the whole app can be exercised (and demoed, and E2E-tested on an
 * emulator) without hardware.
 */
import { MockTransport } from '@/ble/MockTransport';
import { PlxTransport } from '@/ble/PlxTransport';
import { mirrorSide, session0007 } from '@/ble/replay';
import type { BleTransport } from '@/ble/transport';
import { systemClock, type Clock } from '@/core/clock';
import { openRepository } from '@/db/open';
import type { SessionRepository } from '@/db/SessionRepository';
import { DeviceManager } from '@/services/DeviceManager';
import { GaitAcquisition } from '@/services/GaitAcquisition';
import { SessionRecorder } from '@/services/SessionRecorder';

export type TransportMode = 'ble' | 'replay';

export interface Services {
  mode: TransportMode;
  clock: Clock;
  transport: BleTransport;
  dm: DeviceManager;
  repo: SessionRepository;
  recorder: SessionRecorder;
  acquisition: GaitAcquisition;
}

export function replayTransport(clock: Clock): MockTransport {
  const left = session0007();
  return new MockTransport(clock, [
    { id: 'replay-L', side: 'L', mode: 2, strides: left, rssi: -58 },
    {
      id: 'replay-R',
      side: 'R',
      mode: 2,
      strides: mirrorSide(left, { swingAsymmetry: 0.04, lengthAsymmetry: -0.03 }),
      rssi: -66,
      firstStrideDelayMs: 1650,
    },
  ]);
}

export function createServices(
  mode: TransportMode,
  appVersion: string,
  deps: { clock?: Clock; repo?: SessionRepository; transport?: BleTransport } = {},
): Services {
  const clock = deps.clock ?? systemClock;
  const transport =
    deps.transport ?? (mode === 'replay' ? replayTransport(clock) : new PlxTransport());
  const repo = deps.repo ?? openRepository();
  const dm = new DeviceManager(transport, clock);
  const recorder = new SessionRecorder({ dm, repo, clock, appVersion });
  const acquisition = new GaitAcquisition(dm, clock);
  acquisition.start();
  return { mode, clock, transport, dm, repo, recorder, acquisition };
}
