import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { colors, font, radius, space } from './theme';

type Tone = 'default' | 'primary' | 'danger' | 'ok' | 'warn';

const TONE_BG: Record<Tone, string> = {
  default: colors.surfaceHi,
  primary: colors.accent,
  danger: colors.danger,
  ok: colors.ok,
  warn: colors.warn,
};

export function Button(props: {
  label: string;
  onPress: () => void;
  tone?: Tone;
  disabled?: boolean;
  active?: boolean;
  style?: ViewStyle;
  testID?: string;
  hint?: string;
}) {
  const { label, onPress, tone = 'default', disabled, active, style, testID, hint } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: TONE_BG[tone] },
        active && styles.active,
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <Text style={[styles.buttonText, tone !== 'default' && styles.buttonTextOnColor]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({
  title,
  children,
  right,
}: {
  title?: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View style={styles.card}>
      {title || right ? (
        <View style={styles.cardHeader}>
          {title ? <Text style={styles.cardTitle}>{title}</Text> : <View />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Banner({
  tone,
  text,
  testID,
}: {
  tone: 'warn' | 'danger' | 'ok';
  text: string;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[styles.banner, { borderColor: colors[tone] }]}
    >
      <Text style={[styles.bannerText, { color: colors[tone] }]}>{text}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Dim({ children }: { children: ReactNode }) {
  return <Text style={styles.dim}>{children}</Text>;
}

export function Body({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.body} testID={testID}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  active: { borderColor: colors.text, borderWidth: 2 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  buttonText: { color: colors.text, fontSize: font.body, fontWeight: '600', textAlign: 'center' },
  buttonTextOnColor: { color: '#0B0F14' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius,
    padding: space.md,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.sm,
  },
  cardTitle: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  banner: {
    borderWidth: 1,
    borderRadius: radius,
    padding: space.md,
    marginBottom: space.md,
    backgroundColor: colors.surface,
  },
  bannerText: { fontSize: font.body, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  dim: { color: colors.textDim, fontSize: font.small },
  body: { color: colors.text, fontSize: font.body },
});
