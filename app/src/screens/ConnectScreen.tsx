/** Scanner / connection screen (F01-F12). */
import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SIDES, type Side } from '@/ble/gatt';
import { ensureBlePermissions, type PermissionOutcome } from '@/ble/permissions';
import type { SideLink } from '@/services/DeviceManager';
import { useServices } from '@/state/ServicesContext';
import { useAppStore } from '@/state/store';
import { Banner, Body, Button, Card, Dim, Row } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';

const STATE_TEXT: Record<SideLink['state'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  discovering: 'Reading services…',
  ready: 'Connected',
  reconnecting: 'Reconnecting…',
};

function stateColor(link: SideLink): string {
  if (link.state === 'ready') return colors.ok;
  if (link.state === 'idle') return colors.textDim;
  return colors.warn;
}

export function adapterMessage(
  adapter: string,
  permission: PermissionOutcome | null,
): string | null {
  if (permission === 'blocked')
    return 'Bluetooth permission is blocked. Enable it in Settings to scan.';
  if (permission === 'denied') return 'Bluetooth permission is needed to find the ankle sensors.';
  if (adapter === 'poweredOff') return 'Bluetooth is off. Turn it on to connect the sensors.';
  if (adapter === 'unauthorized')
    return 'Bluetooth access is not allowed for ARC SENSE. Enable it in Settings.';
  if (adapter === 'unsupported') return 'This device does not support Bluetooth Low Energy.';
  return null;
}

function SideCard({ side }: { side: Side }) {
  const { dm } = useServices();
  const link = useAppStore((s) => s.links[side]);
  const gatt = link.gatt;
  const issues = gatt ? [...gatt.missing, ...gatt.propertyMismatches] : [];
  return (
    <Card
      title={side === 'L' ? 'Left ankle' : 'Right ankle'}
      right={
        <Text testID={`state-${side}`} style={[styles.state, { color: stateColor(link) }]}>
          {STATE_TEXT[link.state]}
          {link.state === 'reconnecting' && link.reconnectAttempt
            ? ` (try ${link.reconnectAttempt})`
            : ''}
        </Text>
      }
    >
      <Dim>{link.name ?? 'No device assigned'}</Dim>
      {link.mode ? <Dim>Firmware mode: {link.mode}</Dim> : null}
      {issues.length ? <Dim>Missing from firmware: {issues.join(', ')}</Dim> : null}
      {link.lastError && link.state !== 'ready' ? <Dim>Last error: {link.lastError}</Dim> : null}
      {link.state !== 'idle' ? (
        <Row style={styles.gapTop}>
          <Button
            label="Disconnect"
            onPress={() => void dm.disconnect(side)}
            testID={`disconnect-${side}`}
          />
        </Row>
      ) : link.deviceId ? (
        <Row style={styles.gapTop}>
          <Button
            label={`Reconnect ${link.name ?? ''}`.trim()}
            onPress={() => void dm.connect(link.deviceId!, side).catch(() => undefined)}
            testID={`reconnect-${side}`}
          />
          <Button label="Forget" onPress={() => void dm.forget(side)} />
        </Row>
      ) : null}
    </Card>
  );
}

function rssiBars(rssi: number | null): string {
  if (rssi === null) return '—';
  const bars = rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1;
  return `${'▮'.repeat(bars)}${'▯'.repeat(4 - bars)} ${rssi} dBm`;
}

export function ConnectScreen({
  requestPermissions = ensureBlePermissions,
}: {
  requestPermissions?: () => Promise<PermissionOutcome>;
}) {
  const { dm, mode } = useServices();
  const adapter = useAppStore((s) => s.adapter);
  const discovered = useAppStore((s) => s.discovered);
  const scanning = useAppStore((s) => s.scanning);
  const links = useAppStore((s) => s.links);
  const [permission, setPermission] = useState<PermissionOutcome | null>(null);

  useEffect(() => {
    let alive = true;
    void requestPermissions().then((p) => {
      if (!alive) return;
      setPermission(p);
      if (p === 'granted') void dm.init();
    });
    return () => {
      alive = false;
    };
  }, [dm, requestPermissions]);

  const message = adapterMessage(adapter, permission);
  const canScan = permission === 'granted' && adapter === 'poweredOn';
  const needsConnect = SIDES.some((s) => links[s].state === 'idle');

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {mode === 'replay' ? (
        <Banner
          tone="warn"
          testID="replay-banner"
          text="Replay mode: virtual ankles replaying session 0007"
        />
      ) : null}
      {message ? <Banner tone="danger" text={message} testID="adapter-banner" /> : null}
      {permission === 'blocked' || adapter === 'unauthorized' ? (
        <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
      ) : null}

      <View style={styles.sides}>
        {SIDES.map((s) => (
          <SideCard key={s} side={s} />
        ))}
      </View>

      <Card
        title="Nearby sensors"
        right={
          <Button
            label={scanning ? 'Stop' : 'Scan'}
            tone={scanning ? 'default' : 'primary'}
            disabled={!canScan}
            onPress={() => (scanning ? dm.stopScan() : dm.startScan())}
            testID="scan"
          />
        }
      >
        {discovered.length === 0 ? (
          <Dim>
            {scanning
              ? 'Searching for ArcSense-L and ArcSense-R…'
              : 'Tap Scan to find the ankle sensors.'}
          </Dim>
        ) : (
          discovered.map((d) => (
            <Row key={d.id} style={styles.deviceRow}>
              <View style={styles.flex}>
                <Body>{d.name}</Body>
                <Dim>{rssiBars(d.rssi)}</Dim>
              </View>
              <Button
                label="Connect"
                disabled={!d.side || links[d.side].state !== 'idle'}
                onPress={() => void dm.connect(d.id).catch(() => undefined)}
                testID={`connect-${d.id}`}
              />
            </Row>
          ))
        )}
        {needsConnect && discovered.length > 0 ? (
          <Button
            label="Connect both"
            tone="primary"
            style={styles.gapTop}
            onPress={() => void dm.connectBoth()}
            testID="connect-both"
          />
        ) : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  sides: { marginBottom: space.sm },
  state: { fontSize: font.body, fontWeight: '700' },
  deviceRow: { justifyContent: 'space-between', paddingVertical: space.sm, flexWrap: 'nowrap' },
  flex: { flex: 1 },
  gapTop: { marginTop: space.sm },
});
