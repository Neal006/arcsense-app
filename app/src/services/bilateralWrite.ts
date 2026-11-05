/**
 * Write one value to the same characteristic on both ankles, dispatching the
 * two writes in the same JS turn (no await in between) and reporting each
 * side's outcome. Used for sync tokens, session start and label markers.
 */
import { SIDES, type CharKey, type Side } from '@/ble/gatt';
import type { Clock } from '@/core/clock';

import type { DeviceManager } from './DeviceManager';

export interface SideWrite {
  status: 'sent' | 'failed' | 'skipped';
  /** Phone monotonic ms immediately before the write was handed to the BLE stack. */
  dispatchT: number | null;
  writeMode: 'without-response' | 'with-response' | null;
  error: string | null;
}

export type BilateralWrite = Record<Side, SideWrite>;

export async function writeBoth(
  dm: DeviceManager,
  clock: Clock,
  key: CharKey,
  value: number,
  fast: boolean,
): Promise<BilateralWrite> {
  const pending = SIDES.map((side) => {
    if (!dm.isReady(side)) return null;
    const dispatchT = clock.now();
    const p = fast
      ? dm.writeFast(side, key, value)
      : dm.write(side, key, value, true).then(() => 'with-response' as const);
    return { dispatchT, p };
  });
  const settled = await Promise.all(
    pending.map((x) =>
      x
        ? x.p.then(
            (mode) => ({ ok: true as const, mode }),
            (e: unknown) => ({ ok: false as const, e }),
          )
        : null,
    ),
  );
  const out = {} as BilateralWrite;
  SIDES.forEach((side, i) => {
    const p = pending[i];
    const res = settled[i];
    if (!p || !res) {
      out[side] = { status: 'skipped', dispatchT: null, writeMode: null, error: 'not connected' };
    } else if (res.ok) {
      out[side] = { status: 'sent', dispatchT: p.dispatchT, writeMode: res.mode, error: null };
    } else {
      out[side] = {
        status: 'failed',
        dispatchT: p.dispatchT,
        writeMode: null,
        error: res.e instanceof Error ? res.e.message : String(res.e),
      };
    }
  });
  return out;
}

export function deliveredToBoth(w: BilateralWrite): boolean {
  return SIDES.every((s) => w[s].status === 'sent');
}
