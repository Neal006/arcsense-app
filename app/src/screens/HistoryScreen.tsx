/** Recorded sessions with export (F46 list, F49). */
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import type { SessionRow } from '@/db/SessionRepository';
import { exportAndShare } from '@/export/share';
import { useServices } from '@/state/ServicesContext';
import { useAppStore } from '@/state/store';
import { Banner, Body, Button, Card, Dim, Row } from '@/ui/components';
import { colors, space } from '@/ui/theme';

import { formatDuration } from './format';

export function HistoryScreen({ share = exportAndShare }: { share?: typeof exportAndShare }) {
  const { repo } = useServices();
  useAppStore((s) => s.recorder); // refresh when a session starts/stops
  const [error, setError] = useState<string | null>(null);
  const sessions = repo.listSessions();
  const onExport = useCallback(
    (id: string) => {
      setError(null);
      void share(repo, id).catch((e: Error) => setError(e.message));
    },
    [repo, share],
  );

  const render = ({ item }: { item: SessionRow }) => {
    const duration =
      item.startedWall && item.stoppedWall
        ? formatDuration(item.stoppedWall - item.startedWall)
        : '—';
    return (
      <Card title={item.subjectCode} right={<Dim>{item.status}</Dim>}>
        <Body>{item.condition}</Body>
        <Dim>
          {new Date(item.createdWall).toLocaleString()} · {duration} ·{' '}
          {item.plannedSides === 'LR' ? 'both ankles' : `${item.plannedSides} only`}
        </Dim>
        <Row style={styles.gap}>
          <Button
            label="Export"
            onPress={() => onExport(item.id)}
            disabled={item.status === 'running'}
            testID={`export-${item.id}`}
          />
        </Row>
      </Card>
    );
  };

  return (
    <View style={styles.root}>
      {error ? <Banner tone="danger" text={`Export failed: ${error}`} /> : null}
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        renderItem={render}
        contentContainerStyle={styles.content}
        ListEmptyComponent={<Dim>No sessions recorded yet.</Dim>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  gap: { marginTop: space.sm },
});
