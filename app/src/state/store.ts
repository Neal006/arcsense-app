/**
 * UI state mirrored from the services. Screens read from here and call the
 * services directly for actions; only bind.ts writes to the store.
 */
import { create } from 'zustand';

import type { Side } from '@/ble/gatt';
import type { AdapterState } from '@/ble/transport';
import type { SessionRow } from '@/db/SessionRepository';
import type { ConnectionEvent, DiscoveredDevice, SideLink } from '@/services/DeviceManager';
import type { LabelRecord, NoteRecord } from '@/services/LabelService';
import type { RecorderState } from '@/services/SessionRecorder';
import type { ActiveAlert } from '@/services/AlertEngine';
import type { BilateralPair } from '@/services/GaitAcquisition';
import type { Stride } from '@/services/StrideAssembler';
import type { SyncTokenRecord } from '@/services/SyncService';

export const EVENT_LOG_LIMIT = 200;
export const TREND_LIMIT = 40;

export interface AppState {
  adapter: AdapterState;
  links: Record<Side, SideLink>;
  discovered: DiscoveredDevice[];
  scanning: boolean;
  events: ConnectionEvent[];
  recorder: RecorderState;
  session: SessionRow | null;
  tokens: SyncTokenRecord[];
  labels: LabelRecord[];
  openEpisodeIds: number[];
  notes: NoteRecord[];
  recent: Record<Side, Stride[]>;
  lastPair: BilateralPair | null;
  asymmetryTrend: number[];
  alerts: ActiveAlert[];
}

export function initialState(): AppState {
  const link = (side: Side): SideLink => ({
    side,
    deviceId: null,
    name: null,
    state: 'idle',
    mode: null,
    gatt: null,
    reconnectAttempt: 0,
    lastError: null,
    readyAt: null,
  });
  return {
    adapter: 'unknown',
    links: { L: link('L'), R: link('R') },
    discovered: [],
    scanning: false,
    events: [],
    recorder: 'idle',
    session: null,
    tokens: [],
    labels: [],
    openEpisodeIds: [],
    notes: [],
    recent: { L: [], R: [] },
    lastPair: null,
    asymmetryTrend: [],
    alerts: [],
  };
}

export const useAppStore = create<AppState>()(() => initialState());
