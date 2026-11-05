import { StyleSheet, Text, View } from 'react-native';

import { fraction, inNorm, NORMS, type NormKey } from './norms';
import { colors, font, space } from './theme';

export function MetricBar({
  metric,
  value,
  testID,
  color,
}: {
  metric: NormKey;
  value: number | null | undefined;
  testID?: string;
  color?: string;
}) {
  const n = NORMS[metric];
  const has = value !== null && value !== undefined && Number.isFinite(value);
  const ok = has && inNorm(metric, value);
  const barColor = color ?? (ok ? colors.ok : colors.warn);
  return (
    <View
      style={styles.row}
      testID={testID}
      accessible
      accessibilityLabel={`${n.label} ${has ? value.toFixed(n.digits) : 'no data'} ${n.unit}`}
    >
      <Text style={styles.label}>{n.label}</Text>
      <View style={styles.track}>
        <View
          style={[
            styles.band,
            {
              left: `${fraction(metric, n.lo) * 100}%`,
              width: `${(fraction(metric, n.hi) - fraction(metric, n.lo)) * 100}%`,
            },
          ]}
        />
        {has ? (
          <View
            style={[
              styles.fill,
              { width: `${fraction(metric, value) * 100}%`, backgroundColor: barColor },
            ]}
          />
        ) : null}
      </View>
      <Text style={styles.value}>
        {has ? value.toFixed(n.digits) : '—'}
        {n.unit ? ` ${n.unit}` : ''}
      </Text>
    </View>
  );
}

export function Series({
  values,
  metric,
  color,
  testID,
}: {
  values: number[];
  metric: NormKey;
  color: string;
  testID?: string;
}) {
  return (
    <View style={styles.series} testID={testID}>
      {values.map((v, i) => (
        <View
          key={i}
          style={[
            styles.seriesBar,
            { height: `${Math.max(2, fraction(metric, v) * 100)}%`, backgroundColor: color },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: space.xs, gap: space.sm },
  label: { color: colors.textDim, fontSize: font.small, width: 92 },
  track: {
    flex: 1,
    height: 14,
    backgroundColor: colors.surfaceHi,
    borderRadius: 7,
    overflow: 'hidden',
  },
  band: { position: 'absolute', top: 0, bottom: 0, backgroundColor: '#2D4A33' },
  fill: { position: 'absolute', left: 0, top: 3, bottom: 3, borderRadius: 4 },
  value: {
    color: colors.text,
    fontSize: font.body,
    width: 84,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  series: { flexDirection: 'row', alignItems: 'flex-end', height: 48, gap: 2, marginTop: space.xs },
  seriesBar: { flex: 1, borderRadius: 2 },
});
