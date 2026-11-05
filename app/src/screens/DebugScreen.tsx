/** GATT inspector, sync log and connection event log (F40). */
import { ScrollView, StyleSheet } from 'react-native';

import { SIDES } from '@/ble/gatt';
import { setConfiguredMode } from '@/state/bootstrap';
import { useServices } from '@/state/ServicesContext';
import { useAppStore } from '@/state/store';
import { Body, Button, Card, Dim, Row } from '@/ui/components';
import { colors, space } from '@/ui/theme';

import { tokenHex } from './format';

export function DebugScreen({
  persistMode = setConfiguredMode,
}: {
  persistMode?: typeof setConfiguredMode;
}) {
  const { mode } = useServices();
  const links = useAppStore((s) => s.links);
  const tokens = useAppStore((s) => s.tokens);
  const events = useAppStore((s) => s.events);
  const other = mode === 'replay' ? 'ble' : 'replay';

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Card title="Transport">
        <Body testID="mode">
          Mode: {mode === 'replay' ? 'Replay (virtual ankles)' : 'Bluetooth'}
        </Body>
        <Row style={styles.gap}>
          <Button
            label={`Use ${other === 'replay' ? 'replay' : 'Bluetooth'} on next start`}
            onPress={() => persistMode(other)}
            testID="toggle-mode"
          />
        </Row>
        <Dim>The transport is chosen when the app starts. Restart the app to apply.</Dim>
      </Card>

      {SIDES.map((side) => {
        const g = links[side].gatt;
        return (
          <Card key={side} title={`GATT ${side}`}>
            {!g ? (
              <Dim>Not discovered yet.</Dim>
            ) : (
              <>
                <Body>
                  {g.checks.filter((c) => c.present).length}/{g.checks.length} characteristics ·
                  streaming {g.gaitCharacteristicsComplete ? 'complete' : 'INCOMPLETE'} · session
                  control {g.sessionControlAvailable ? 'ok' : 'MISSING'}
                </Body>
                {g.missing.length ? <Dim>Missing: {g.missing.join(', ')}</Dim> : null}
                {g.propertyMismatches.length ? (
                  <Dim>Wrong properties: {g.propertyMismatches.join(', ')}</Dim>
                ) : null}
                {g.unknown.length ? (
                  <Dim>Unknown: {g.unknown.map((u) => u.uuid).join(', ')}</Dim>
                ) : null}
                <Dim>Telemetry packet: {g.telemetryPacketPresent ? 'present' : 'absent'}</Dim>
              </>
            )}
          </Card>
        );
      })}

      <Card title={`Sync tokens (${tokens.length})`}>
        {tokens.slice(-10).map((t) => (
          <Dim key={t.seq}>
            {tokenHex(t.token)} {t.reason} · L {t.sides.L.status} · R {t.sides.R.status}
            {t.jsDispatchSkewMs !== null ? ` · skew ${t.jsDispatchSkewMs.toFixed(1)} ms` : ''}
          </Dim>
        ))}
      </Card>

      <Card title={`Connection log (${events.length})`}>
        {events
          .slice(-40)
          .reverse()
          .map((e, i) => (
            <Dim key={`${e.t}-${i}`}>
              {(e.t / 1000).toFixed(1)} s {e.side ?? '-'} {e.type}
              {e.detail ? `: ${e.detail}` : ''}
            </Dim>
          ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  gap: { marginVertical: space.sm },
});
