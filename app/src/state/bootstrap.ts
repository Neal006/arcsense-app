/**
 * App-process singleton: chooses the transport mode, builds services and binds
 * the store. Mode comes from a persisted setting, overridable at build time
 * with EXPO_PUBLIC_TRANSPORT_MODE=replay (used for emulator E2E builds).
 */
import Constants from 'expo-constants';
import Storage from 'expo-sqlite/kv-store';

import { bindServices } from './bind';
import { createServices, type Services, type TransportMode } from './services';

const MODE_KEY = 'transportMode';
let services: Services | null = null;

export function configuredMode(): TransportMode {
  const env = process.env.EXPO_PUBLIC_TRANSPORT_MODE;
  if (env === 'replay' || env === 'ble') return env;
  return Storage.getItemSync(MODE_KEY) === 'replay' ? 'replay' : 'ble';
}

/** Persist the mode for the next app start (services are built once per process). */
export function setConfiguredMode(mode: TransportMode): void {
  Storage.setItemSync(MODE_KEY, mode);
}

export function getAppServices(): Services {
  if (services) return services;
  services = createServices(configuredMode(), Constants.expoConfig?.version ?? '0.0.0');
  bindServices(services.dm, services.recorder, undefined, services.acquisition);
  return services;
}
