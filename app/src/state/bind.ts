/** Wire service events into the store. Returns a function that unbinds everything. */
import type { Unsubscribe } from '@/core/emitter';
import type { DeviceManager } from '@/services/DeviceManager';
import type { SessionRecorder } from '@/services/SessionRecorder';

import { EVENT_LOG_LIMIT, useAppStore, type AppState } from './store';

type StoreApi = { setState: (p: Partial<AppState>) => void; getState: () => AppState };

export function bindServices(
  dm: DeviceManager,
  recorder: SessionRecorder,
  store: StoreApi = useAppStore,
): Unsubscribe {
  const offs: Unsubscribe[] = [];
  let sessionOffs: Unsubscribe[] = [];

  store.setState({
    adapter: dm.getAdapterState(),
    links: { ...dm.getLinks() },
    discovered: dm.getDiscovered(),
    scanning: dm.scanning(),
    events: dm.getEventLog().slice(-EVENT_LOG_LIMIT),
    recorder: recorder.state(),
    session: recorder.current(),
  });

  offs.push(
    dm.on('adapter', (adapter) => store.setState({ adapter })),
    dm.on('links', (links) => store.setState({ links: { ...links } })),
    dm.on('scan', (list) => store.setState({ discovered: [...list] })),
    dm.on('scanning', (scanning) => store.setState({ scanning })),
    dm.on('event', (e) => {
      const events = [...store.getState().events, e];
      store.setState({ events: events.slice(-EVENT_LOG_LIMIT) });
    }),
    recorder.on('state', (s) => store.setState({ recorder: s })),
  );

  const bindSession = () => {
    for (const off of sessionOffs) off();
    sessionOffs = [];
    if (recorder.state() !== 'running' && recorder.state() !== 'starting') {
      store.setState({ tokens: [], labels: [], openEpisodeIds: [], notes: [] });
      return;
    }
    const sync = recorder.sync();
    const labels = recorder.labels();
    const syncLabels = () =>
      store.setState({
        labels: [...labels.getRecords()],
        openEpisodeIds: labels.open().map((r) => r.labelId),
      });
    store.setState({ tokens: [...sync.getTokens()], notes: [...labels.getNotes()] });
    syncLabels();
    sessionOffs.push(
      sync.on('token', () => store.setState({ tokens: [...sync.getTokens()] })),
      labels.on('changed', syncLabels),
      labels.on('voided', syncLabels),
      labels.on('note', () => store.setState({ notes: [...labels.getNotes()] })),
    );
  };

  offs.push(
    recorder.on('session', (session) => {
      store.setState({ session });
      bindSession();
    }),
  );
  bindSession();

  return () => {
    for (const off of [...offs, ...sessionOffs]) off();
  };
}
