import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { makeHarness } from '@/testing/appHarness';

import { DebugScreen } from '../DebugScreen';
import { HistoryScreen } from '../HistoryScreen';

jest.mock('@/db/open', () => ({ openRepository: () => null }));
jest.mock('@/ble/PlxTransport', () => ({ PlxTransport: jest.fn() }));
jest.mock('@/export/share', () => ({ exportAndShare: jest.fn() }));
jest.mock('@/state/bootstrap', () => ({ setConfiguredMode: jest.fn() }));

const META = {
  subjectCode: 'P002',
  condition: 'Shuffle trial',
  operator: 'op',
  notes: '',
  plannedSides: 'LR' as const,
  affectedSide: null,
};

describe('HistoryScreen', () => {
  it('shows an empty state', async () => {
    const h = makeHarness();
    await render(<HistoryScreen />, { wrapper: h.wrapper });
    expect(screen.getByText('No sessions recorded yet.')).toBeOnTheScreen();
  });

  it('lists sessions; export is disabled while running and calls share when stopped', async () => {
    const share = jest.fn(async () => 'uri');
    const h = makeHarness();
    await h.connectBoth();
    await render(<HistoryScreen share={share} />, { wrapper: h.wrapper });
    await act(() => h.services.recorder.start(META).then(() => undefined));
    expect(screen.getByText('Shuffle trial')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    await act(() => h.services.recorder.stop().then(() => undefined));
    expect(screen.getByText('stopped')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Export' }));
    expect(share).toHaveBeenCalledWith(h.repo, expect.stringMatching(/^P002_/));
  });

  it('reports export failures', async () => {
    const h = makeHarness();
    await h.connectBoth();
    await act(() =>
      h.services.recorder
        .start(META)
        .then(() => h.services.recorder.stop())
        .then(() => undefined),
    );
    await render(<HistoryScreen share={async () => Promise.reject(new Error('disk full'))} />, {
      wrapper: h.wrapper,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('Export failed: disk full')).toBeOnTheScreen();
  });
});

describe('DebugScreen', () => {
  it('shows mode, GATT reports, tokens and the connection log; toggles mode for next start', async () => {
    const persist = jest.fn();
    const h = makeHarness();
    await render(<DebugScreen persistMode={persist} />, { wrapper: h.wrapper });
    expect(screen.getByTestId('mode')).toHaveTextContent('Mode: Replay (virtual ankles)');
    expect(screen.getAllByText('Not discovered yet.')).toHaveLength(2);
    await h.connectBoth();
    expect(
      screen.getAllByText(/15\/15 characteristics · streaming complete · session control ok/),
    ).toHaveLength(2);
    await act(() => h.services.recorder.start(META).then(() => undefined));
    expect(screen.getByText(/0xAA01 start · L sent · R sent/)).toBeOnTheScreen();
    expect(screen.getAllByText(/ready: mode=STREAMING/)).toHaveLength(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Use Bluetooth on next start' }));
    expect(persist).toHaveBeenCalledWith('ble');
  });
});
