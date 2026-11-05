/** Left vs right comparison over the last 20 strides (F38). */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Stride } from '@/services/StrideAssembler';
import { useAppStore } from '@/state/store';
import { Series } from '@/ui/MetricBar';
import { Card, Dim, Row } from '@/ui/components';
import { NORMS, type NormKey } from '@/ui/norms';
import { colors, font, space } from '@/ui/theme';

const METRICS: { key: NormKey; get: (s: Stride) => number | undefined | null }[] = [
  { key: 'strideTimeS', get: (s) => s.values.strideTime },
  { key: 'strideLengthM', get: (s) => s.values.strideLength },
  { key: 'swingPct', get: (s) => s.swingPct },
  { key: 'tibialShockG', get: (s) => s.values.tibialShock },
  { key: 'freezeIndex', get: (s) => s.values.freezeIndex as number | undefined },
];

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function BilateralScreen() {
  const recent = useAppStore((s) => s.recent);
  const trend = useAppStore((s) => s.asymmetryTrend);
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Card title="Asymmetry trend">
        {trend.length ? (
          <Series values={trend} metric="asymmetryPct" color={colors.warn} testID="asym-trend" />
        ) : (
          <Dim>Needs strides from both ankles.</Dim>
        )}
        {trend.length ? <Dim>latest {trend.at(-1)!.toFixed(1)} % · limit 15 %</Dim> : null}
      </Card>
      {METRICS.map(({ key, get }) => {
        const l = recent.L.map(get).filter((x): x is number => typeof x === 'number');
        const r = recent.R.map(get).filter((x): x is number => typeof x === 'number');
        const n = NORMS[key];
        const ml = mean(l);
        const mr = mean(r);
        return (
          <Card key={key} title={n.label}>
            <Row>
              <Text style={[styles.mean, { color: colors.left }]} testID={`mean-L-${key}`}>
                L {ml === null ? '—' : ml.toFixed(n.digits)}
              </Text>
              <Text style={[styles.mean, { color: colors.right }]} testID={`mean-R-${key}`}>
                R {mr === null ? '—' : mr.toFixed(n.digits)}
              </Text>
              <Dim>
                {n.unit} (mean of last {Math.max(l.length, r.length)})
              </Dim>
            </Row>
            <View style={styles.pair}>
              <View style={styles.flex}>
                <Series values={l} metric={key} color={colors.left} />
              </View>
              <View style={styles.flex}>
                <Series values={r} metric={key} color={colors.right} />
              </View>
            </View>
          </Card>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  mean: { fontSize: font.title, fontWeight: '700', fontVariant: ['tabular-nums'] },
  pair: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },
});
