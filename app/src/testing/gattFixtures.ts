import type { DiscoveredCharacteristic } from '@/ble/transport';
import { CHARACTERISTICS } from '@/shared/generated/gatt';

/** The full characteristic set a correct ArcSense firmware exposes. */
export function fullDiscovery(): DiscoveredCharacteristic[] {
  return CHARACTERISTICS.map((c) => {
    const props = c.props as readonly string[];
    return {
      serviceUuid: c.serviceUuid.toUpperCase(),
      uuid: c.uuid.toUpperCase(), // platforms differ in case; consumers must normalise
      isReadable: props.includes('read'),
      isNotifiable: props.includes('notify'),
      isWritableWithResponse: props.includes('write'),
      isWritableWithoutResponse: props.includes('write'),
    };
  });
}
