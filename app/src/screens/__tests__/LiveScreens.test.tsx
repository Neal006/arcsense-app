import { act, render, screen } from '@testing-library/react-native';

import { makeHarness } from '@/testing/appHarness';
import { useAppStore } from '@/state/store';

import { BilateralScreen } from '../BilateralScreen';
import { alertText, DashboardScreen } from '../DashboardScreen';

jest.mock('@/db/open', () => ({ openRepository: () => null }));
jest.mock('@/ble/PlxTransport', () => ({ PlxTransport: jest.fn() }));

describe('alertText', () => {
  it('words each alert for the clinician', () => {
    const base = { side: 'L' as const, since: 0, peak: 4.21 };
    expect(alertText({ ...base, kind: 'freezing' })).toEqual({
      tone: 'danger',
      text: 'FREEZING EPISODE DETECTED (left ankle, FI 4.2)',
    });
    expect(alertText({ ...base, kind: 'preFreeze' }).tone).toBe('warn');
    expect(alertText({ ...base, kind: 'asymmetry', peak: 17.4 }).text).toBe(
      'Asymmetry elevated: 17 %',
    );
    expect(alertText({ ...base, kind: 'shuffling', side: 'R' }).text).toBe(
      'EdgeAI: shuffling (right ankle)',
    );
    expect(alertText({ ...base, kind: 'limping' }).text).toBe('EdgeAI: limping (left ankle)');
  });
});

describe('DashboardScreen', () => {
  it('shows live metrics for both ankles from the replay and the bilateral asymmetry', async () => {
    const h = makeHarness();
    await render(<DashboardScreen />, { wrapper: h.wrapper });
    expect(screen.getAllByText('no strides yet')).toHaveLength(2);
    await h.connectBoth();
    await h.advance(6000);
    expect(screen.getAllByText('live')).toHaveLength(2);
    expect(screen.getByTestId('m-L-strideTime')).toHaveAccessibleName(/Stride time 1\.\d\d s/);
    expect(screen.getByTestId('m-asymmetry')).toHaveAccessibleName(/Asymmetry \d+\.\d %/);
    expect(screen.getAllByText('EdgeAI: no inference from firmware')).toHaveLength(2);
  });

  it('marks data stale when an ankle stops sending', async () => {
    const h = makeHarness();
    await render(<DashboardScreen />, { wrapper: h.wrapper });
    await h.connectBoth();
    await h.advance(4000);
    const t = h.services.transport as import('@/ble/MockTransport').MockTransport;
    t.setAdvertising('replay-R', false);
    t.dropLink('replay-R');
    await h.advance(8000);
    expect(screen.getByText(/last stride \d+ s ago/)).toBeOnTheScreen();
  });

  it('puts the freezing banner first', async () => {
    const h = makeHarness();
    await render(<DashboardScreen />, { wrapper: h.wrapper });
    await act(async () =>
      useAppStore.setState({
        alerts: [
          { kind: 'asymmetry', side: 'L', since: 0, peak: 20 },
          { kind: 'freezing', side: 'R', since: 0, peak: 4.4 },
        ],
      }),
    );
    const banners = screen.getAllByRole('alert');
    expect(banners[0]).toHaveTextContent(/FREEZING EPISODE DETECTED \(right ankle/);
    expect(banners[1]).toHaveTextContent('Asymmetry elevated: 20 %');
  });
});

describe('BilateralScreen', () => {
  it('compares left and right means and shows the asymmetry trend', async () => {
    const h = makeHarness();
    await render(<BilateralScreen />, { wrapper: h.wrapper });
    expect(screen.getAllByText('Needs strides from both ankles.')).toHaveLength(1);
    await h.connectBoth();
    await h.advance(12_000);
    expect(screen.getByTestId('mean-L-strideTimeS')).toHaveTextContent(/^L 1\.\d\d$/);
    expect(screen.getByTestId('mean-R-strideTimeS')).toHaveTextContent(/^R 1\.\d\d$/);
    expect(screen.getByTestId('asym-trend')).toBeOnTheScreen();
    expect(screen.getByText(/latest \d+\.\d % · limit 15 %/)).toBeOnTheScreen();
  });
});
