/** Session control and ground-truth annotation (F21-F34). */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Side } from '@/ble/gatt';
import { exportAndShare } from '@/export/share';
import { LABELS, VOID_LABEL_ID } from '@/shared/generated/labels';
import type { LabelDef } from '@/services/LabelService';
import {
  validateMeta,
  type SessionMetaInput,
  type SessionSummary,
} from '@/services/SessionRecorder';
import { useServices, useTicker } from '@/state/ServicesContext';
import { useAppStore } from '@/state/store';
import { Banner, Body, Button, Card, Dim, Row } from '@/ui/components';
import { colors, font, radius, space } from '@/ui/theme';

import { formatDuration, tokenHex } from './format';

const KEEP_AWAKE_TAG = 'arcsense-session';

type Deps = {
  confirm?: (title: string, message: string, onOk: () => void) => void;
  share?: typeof exportAndShare;
  haptic?: () => void;
};

const defaultConfirm = (title: string, message: string, onOk: () => void) =>
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Stop', style: 'destructive', onPress: onOk },
  ]);

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testID: string;
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Dim>{props.label}</Dim>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        testID={props.testID}
      />
    </View>
  );
}

function Choice<T extends string | null>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testID: string;
}) {
  return (
    <Row>
      {props.options.map((o) => (
        <Button
          key={String(o.value)}
          label={o.label}
          active={o.value === props.value}
          onPress={() => props.onChange(o.value)}
          testID={`${props.testID}-${String(o.value)}`}
        />
      ))}
    </Row>
  );
}

function NewSessionForm({ onStarted }: { onStarted: () => void }) {
  const { recorder } = useServices();
  const links = useAppStore((s) => s.links);
  const [meta, setMeta] = useState<SessionMetaInput>({
    subjectCode: '',
    condition: '',
    operator: '',
    notes: '',
    plannedSides: 'LR',
    affectedSide: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set =
    <K extends keyof SessionMetaInput>(k: K) =>
    (v: SessionMetaInput[K]) =>
      setMeta((m) => ({ ...m, [k]: v }));

  void links; // re-render when connection state changes
  const problems = [...validateMeta(meta)];
  const missing = recorder.missingSides(meta.plannedSides);
  if (missing.length) problems.push(`Connect ${missing.join(' and ')} first.`);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await recorder.start(meta);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="New session">
      <Field
        label="Subject code (no names)"
        value={meta.subjectCode}
        onChange={set('subjectCode')}
        testID="subject"
        placeholder="e.g. P014"
      />
      <Field
        label="Condition / trial type"
        value={meta.condition}
        onChange={set('condition')}
        testID="condition"
        placeholder="e.g. 10 m overground"
      />
      <Field label="Operator" value={meta.operator} onChange={set('operator')} testID="operator" />
      <Field label="Notes" value={meta.notes} onChange={set('notes')} testID="notes" />
      <Dim>Ankles</Dim>
      <Choice
        testID="sides"
        value={meta.plannedSides}
        onChange={set('plannedSides')}
        options={[
          { value: 'LR', label: 'Both' },
          { value: 'L', label: 'Left only' },
          { value: 'R', label: 'Right only' },
        ]}
      />
      <View style={styles.gap} />
      <Dim>Affected side (asymmetric conditions)</Dim>
      <Choice<Side | null>
        testID="affected"
        value={meta.affectedSide}
        onChange={set('affectedSide')}
        options={[
          { value: null, label: 'None' },
          { value: 'L', label: 'Left' },
          { value: 'R', label: 'Right' },
        ]}
      />
      {problems.length && !busy ? (
        <View style={styles.gap} testID="start-problems">
          {problems.map((p) => (
            <Dim key={p}>• {p}</Dim>
          ))}
        </View>
      ) : null}
      {error ? <Banner tone="danger" text={error} testID="start-error" /> : null}
      <Button
        label={busy ? 'Starting…' : 'Start session'}
        tone="primary"
        disabled={busy || problems.length > 0}
        onPress={() => void start()}
        style={styles.gap}
        testID="start"
      />
    </Card>
  );
}

function UnfinishedPrompt({ onDone }: { onDone: () => void }) {
  const { recorder } = useServices();
  const row = recorder.findUnfinished(); // one indexed query; re-evaluated after resume/close
  const [error, setError] = useState<string | null>(null);
  if (!row) return null;
  return (
    <Card title="Unfinished session">
      <Body>
        {row.subjectCode} · {row.condition}
      </Body>
      <Dim>
        The app closed while this session was running. Reconnect the ankles, then resume it, or
        close it.
      </Dim>
      {error ? <Banner tone="danger" text={error} /> : null}
      <Row style={styles.gap}>
        <Button
          label="Resume"
          tone="primary"
          testID="resume"
          onPress={() =>
            void recorder
              .resume(row.id)
              .then(onDone)
              .catch((e: Error) => setError(e.message))
          }
        />
        <Button
          label="Close it"
          testID="abandon"
          onPress={() => {
            recorder.abandon(row.id);
            onDone();
          }}
        />
      </Row>
    </Card>
  );
}

function LabelButton({ def, haptic }: { def: LabelDef; haptic: () => void }) {
  const { recorder } = useServices();
  const open = useAppStore((s) => s.openEpisodeIds);
  useAppStore((s) => s.labels); // re-render on any label change
  const labels = recorder.labels();
  const isEpisode = def.kind === 'start';
  const active = isEpisode && open.includes(def.id);
  const availability = labels.availability(active ? def.pairId! : def.id);
  const label = isEpisode ? `${active ? 'End' : 'Start'} ${def.name}` : def.name;
  return (
    <Button
      label={label}
      active={active}
      tone={active ? 'warn' : 'default'}
      disabled={!availability.enabled}
      hint={availability.reason ?? undefined}
      style={styles.labelButton}
      testID={`label-${def.key}`}
      onPress={() => {
        haptic();
        void (isEpisode ? labels.toggleEpisode(def.id) : labels.press(def.id)).catch(
          () => undefined,
        );
      }}
    />
  );
}

function RunningSession({
  deps,
  onStopped,
}: {
  deps: Required<Deps>;
  onStopped: (s: SessionSummary) => void;
}) {
  const { recorder } = useServices();
  const session = useAppStore((s) => s.session);
  const tokens = useAppStore((s) => s.tokens);
  const labels = useAppStore((s) => s.labels);
  const notes = useAppStore((s) => s.notes);
  const [note, setNote] = useState('');
  const [stopping, setStopping] = useState(false);
  useTicker(1000, true);

  useEffect(() => {
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, []);

  const last = tokens.at(-1);
  const partial = tokens.filter((t) => t.partial).length;
  const episodes = LABELS.filter((l) => l.kind === 'start');
  const instants = LABELS.filter((l) => l.kind === 'instant');
  const lastLabel = [...labels].reverse().find((l) => l.kind !== 'void' && !l.voided);

  const stop = () =>
    deps.confirm(
      'Stop session?',
      'Open episodes will be closed and a final sync token sent.',
      () => {
        setStopping(true);
        void recorder
          .stop()
          .then(onStopped)
          .finally(() => setStopping(false));
      },
    );

  return (
    <>
      <Card
        title={session ? `${session.subjectCode} · ${session.condition}` : 'Session'}
        right={
          <Text style={styles.timer} testID="timer">
            {formatDuration(recorder.elapsedMs())}
          </Text>
        }
      >
        <Row>
          <Body testID="sync-status">
            Sync {last ? tokenHex(last.token) : '—'} · {tokens.length} sent
          </Body>
          <Button
            label="Sync now"
            onPress={() => void recorder.sync().manualSync()}
            testID="manual-sync"
          />
        </Row>
        {last?.partial ? (
          <Banner tone="warn" text="Last sync reached only one ankle." testID="partial-banner" />
        ) : null}
        {partial && !last?.partial ? (
          <Dim>{partial} earlier sync(s) reached only one ankle.</Dim>
        ) : null}
      </Card>

      <Card title="Trials & episodes">
        <View style={styles.grid}>
          {episodes.map((d) => (
            <LabelButton key={d.id} def={d} haptic={deps.haptic} />
          ))}
        </View>
      </Card>

      <Card title="Events">
        <View style={styles.grid}>
          {instants.map((d) => (
            <LabelButton key={d.id} def={d} haptic={deps.haptic} />
          ))}
        </View>
        <Row style={styles.gap}>
          <Button
            label={lastLabel ? `Void "${lastLabel.name}"` : 'Void last label'}
            tone="danger"
            disabled={!lastLabel}
            onPress={() =>
              void recorder
                .labels()
                .press(VOID_LABEL_ID)
                .catch(() => undefined)
            }
            testID="void"
          />
        </Row>
      </Card>

      <Card title="Notes">
        <TextInput
          accessibilityLabel="Note"
          value={note}
          onChangeText={setNote}
          placeholder="Observation…"
          placeholderTextColor={colors.textDim}
          style={styles.input}
          testID="note-input"
        />
        <Button
          label="Add note"
          disabled={!note.trim()}
          style={styles.gap}
          testID="add-note"
          onPress={() => {
            recorder.labels().addNote(note);
            setNote('');
          }}
        />
        {notes.slice(-3).map((n) => (
          <Dim key={n.seq}>• {n.text}</Dim>
        ))}
      </Card>

      <Button
        label={stopping ? 'Stopping…' : 'Stop session'}
        tone="danger"
        disabled={stopping}
        onPress={stop}
        testID="stop"
      />
    </>
  );
}

function SummaryCard({
  summary,
  onExport,
  onDismiss,
}: {
  summary: SessionSummary;
  onExport: () => void;
  onDismiss: () => void;
}) {
  return (
    <Card title="Session saved">
      <Body testID="summary">
        {formatDuration(summary.durationMs)} · {summary.tokens} sync tokens ({summary.partialTokens}{' '}
        partial) · {summary.labels} labels ({summary.voidedLabels} voided)
      </Body>
      {summary.autoClosedEpisodes ? (
        <Dim>{summary.autoClosedEpisodes} open episode(s) were closed at stop.</Dim>
      ) : null}
      {summary.linkLosses ? (
        <Dim>{summary.linkLosses} link loss(es) during the session.</Dim>
      ) : null}
      <Row style={styles.gap}>
        <Button label="Export" tone="primary" onPress={onExport} testID="export" />
        <Button label="New session" onPress={onDismiss} testID="dismiss-summary" />
      </Row>
    </Card>
  );
}

export function SessionScreen(props: Deps = {}) {
  const services = useServices();
  const recorderState = useAppStore((s) => s.recorder);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [, setRefresh] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const deps: Required<Deps> = {
    confirm: props.confirm ?? defaultConfirm,
    share: props.share ?? exportAndShare,
    haptic: props.haptic ?? (() => void Haptics.selectionAsync()),
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {recorderState === 'running' || recorderState === 'stopping' ? (
        <RunningSession deps={deps} onStopped={setSummary} />
      ) : summary ? (
        <>
          <SummaryCard
            summary={summary}
            onExport={() =>
              void deps
                .share(services.repo, summary.sessionId)
                .catch((e: Error) => setExportError(e.message))
            }
            onDismiss={() => setSummary(null)}
          />
          {exportError ? <Banner tone="danger" text={`Export failed: ${exportError}`} /> : null}
        </>
      ) : (
        <>
          <UnfinishedPrompt onDone={() => setRefresh((n) => n + 1)} />
          <NewSessionForm onStarted={() => setSummary(null)} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: 48 },
  field: { marginBottom: space.md },
  input: {
    color: colors.text,
    backgroundColor: colors.surfaceHi,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.body,
    marginTop: space.xs,
  },
  gap: { marginTop: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  labelButton: { minWidth: '47%', flexGrow: 1, minHeight: 56 },
  timer: {
    color: colors.text,
    fontSize: font.big,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
});
