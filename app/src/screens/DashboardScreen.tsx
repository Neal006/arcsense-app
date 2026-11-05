/** Live gait dashboard (F35) with alert banners (F36). */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { SIDES, type Side } from '@/ble/gatt';
import { CLASS_NAMES } from '@/shared/generated/features';
import type { ActiveAlert } from '@/services/AlertEngine';
import type { Stride } from '@/services/StrideAssembler';
import { useServices, useTicker } from '@/state/ServicesContext';
import { useAppStore } from '@/state/store';
import { MetricBar } from '@/ui/MetricBar';
import { Banner, Card, Dim } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';

export const STALE_AFTER_MS = 3000;

const CLASS_COLOR = [colors.normal, colors.freezing, colors.shuffling, colors.limping];

export function alertText(a: ActiveAlert): { tone: 'danger' | 'warn'; text: string } {
  const side = a.side === 'L' ? 'left' : 'right';
  switch (a.kind) {
    case 'freezing':
      return {
        tone: 'danger',
        text: `FREEZING EPISODE DETECTED (${side} ankle, FI ${a.peak.toFixed(1)})`,
      };
    case 'preFreeze':
      return { tone: 'warn', text: `Freeze index rising (${side} ankle)` };
    case 'asymmetry':
      return { tone: 'warn', text: `Asymmetry elevated: ${a.peak.toFixed(0)} %` };
    case 'shuffling':
      return { tone: 'warn', text: `EdgeAI: shuffling (${side} ankle)` };
    case 'limping':
      return { tone: 'warn', text: `EdgeAI: limping (${side} ankle)` };
  }
}

function SideMetrics({
  side,
  stride,
  now,
}: {
  side: Side;
  stride: Stride | undefined;
  now: number;
}) {
  const v = stride?.values;
  const stale = !stride || now - stride.t > STALE_AFTER_MS;
  return (
    <Card
      title={side === 'L' ? 'Left' : 'Right'}
      right={
        <Dim>
          {stride
            ? stale
              ? `last stride ${((now - stride.t) / 1000).toFixed(0)} s ago`
              : 'live'
            : 'no strides yet'}
        </Dim>
      }
    >
      <MetricBar metric="strideTimeS" value={v?.strideTime} testID={`m-${side}-strideTime`} />
      <MetricBar metric="cadenceSpm" value={stride?.cadenceSpm} />
      <MetricBar metric="strideLengthM" value={v?.strideLength} />
      <MetricBar metric="tibialShockG" value={v?.tibialShock} />
      <MetricBar metric="swingPct" value={stride?.swingPct} />
      <MetricBar metric="stancePct" value={stride?.stancePct} />
      <MetricBar
        metric="freezeIndex"
        value={v?.freezeIndex}
        color={v?.freezeIndex !== undefined && v.freezeIndex >= 3 ? colors.danger : undefined}
      />
      {stride?.aiLabel !== null && stride?.aiLabel !== undefined ? (
        <Text style={[styles.ai, { color: CLASS_COLOR[stride.aiLabel] }]} testID={`ai-${side}`}>
          EdgeAI: {CLASS_NAMES[stride.aiLabel]} ({Math.round((stride.aiConfidence ?? 0) * 100)} %)
        </Text>
      ) : (
        <Dim>EdgeAI: no inference from firmware</Dim>
      )}
    </Card>
  );
}

export function DashboardScreen() {
  const { clock } = useServices();
  const recent = useAppStore((s) => s.recent);
  const alerts = useAppStore((s) => s.alerts);
  const pair = useAppStore((s) => s.lastPair);
  useTicker(1000, true);
  const now = clock.now();
  const asym = pair ? (pair.asymmetryPct.swingTime ?? pair.asymmetryPct.strideTime) : undefined;
  const sorted = [...alerts].sort((a, b) =>
    a.kind === 'freezing' ? -1 : b.kind === 'freezing' ? 1 : 0,
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {sorted.map((a) => {
        const t = alertText(a);
        return (
          <Banner
            key={`${a.kind}-${a.side}`}
            tone={t.tone}
            text={t.text}
            testID={`alert-${a.kind}-${a.side}`}
          />
        );
      })}
      <Card title="Bilateral">
        <MetricBar
          metric="asymmetryPct"
          value={asym}
          testID="m-asymmetry"
          color={asym !== undefined && asym > 15 ? colors.warn : undefined}
        />
        {!pair ? <Dim>Needs strides from both ankles.</Dim> : null}
      </Card>
      <View>
        {SIDES.map((s) => (
          <SideMetrics key={s} side={s} stride={recent[s].at(-1)} now={now} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  ai: { fontSize: font.body, fontWeight: '700', marginTop: space.sm },
});
