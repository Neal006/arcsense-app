import { PermissionsAndroid } from 'react-native';

import { ensureBlePermissions, requiredAndroidPermissions } from '../permissions';

const P = PermissionsAndroid.PERMISSIONS;
const R = PermissionsAndroid.RESULTS;

describe('BLE permissions', () => {
  it('asks for scan + connect on Android 12+ and location on older versions', () => {
    expect(requiredAndroidPermissions(31)).toEqual([P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT]);
    expect(requiredAndroidPermissions(30)).toEqual([P.ACCESS_FINE_LOCATION]);
  });

  it('reports granted, denied and blocked', async () => {
    const env = (answers: string[]) => ({
      os: 'android',
      apiLevel: 34,
      request: jest.fn(async (perms: string[]) =>
        Object.fromEntries(perms.map((p, i) => [p, answers[i]!])),
      ),
    });
    expect(await ensureBlePermissions(env([R.GRANTED, R.GRANTED]))).toBe('granted');
    expect(await ensureBlePermissions(env([R.GRANTED, R.DENIED]))).toBe('denied');
    expect(await ensureBlePermissions(env([R.NEVER_ASK_AGAIN, R.DENIED]))).toBe('blocked');
  });

  it('does not prompt on iOS (the system prompts on first use)', async () => {
    const request = jest.fn();
    expect(await ensureBlePermissions({ os: 'ios', apiLevel: 0, request })).toBe('granted');
    expect(request).not.toHaveBeenCalled();
  });
});
