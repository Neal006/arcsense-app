/**
 * Runtime Bluetooth permissions (functionality F01).
 * Android 12+ (API 31): BLUETOOTH_SCAN (declared neverForLocation) + BLUETOOTH_CONNECT.
 * Android <= 11: fine location is required for BLE scanning.
 * iOS: the system prompts on first Bluetooth use; a denial surfaces as adapter
 * state 'unauthorized', which the Connect screen explains.
 */
import { PermissionsAndroid, Platform, type Permission } from 'react-native';

export type PermissionOutcome = 'granted' | 'denied' | 'blocked';

export interface PermissionEnv {
  os: string;
  apiLevel: number;
  request: (perms: Permission[]) => Promise<Record<string, string>>;
}

const defaultEnv = (): PermissionEnv => ({
  os: Platform.OS,
  apiLevel: typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version),
  request: (perms) => PermissionsAndroid.requestMultiple(perms),
});

export function requiredAndroidPermissions(apiLevel: number): Permission[] {
  const P = PermissionsAndroid.PERMISSIONS;
  return apiLevel >= 31 ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT] : [P.ACCESS_FINE_LOCATION];
}

export async function ensureBlePermissions(
  env: PermissionEnv = defaultEnv(),
): Promise<PermissionOutcome> {
  if (env.os !== 'android') return 'granted';
  const perms = requiredAndroidPermissions(env.apiLevel);
  const result = await env.request(perms);
  const values = perms.map((p) => result[p]);
  if (values.every((v) => v === PermissionsAndroid.RESULTS.GRANTED)) return 'granted';
  if (values.some((v) => v === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) return 'blocked';
  return 'denied';
}
