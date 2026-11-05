import { fireEvent, render, screen } from '@testing-library/react-native';

import { makeHarness } from '@/testing/appHarness';

import { adapterMessage, ConnectScreen } from '../ConnectScreen';

jest.mock('@/db/open', () => ({ openRepository: () => null }));
jest.mock('@/ble/PlxTransport', () => ({ PlxTransport: jest.fn() }));

describe('adapterMessage', () => {
  it('explains every blocking state', () => {
    expect(adapterMessage('poweredOn', 'granted')).toBeNull();
    expect(adapterMessage('poweredOn', 'blocked')).toMatch(/blocked/);
    expect(adapterMessage('poweredOn', 'denied')).toMatch(/needed/);
    expect(adapterMessage('poweredOff', 'granted')).toMatch(/off/);
    expect(adapterMessage('unauthorized', 'granted')).toMatch(/not allowed/);
    expect(adapterMessage('unsupported', 'granted')).toMatch(/does not support/);
  });
});

describe('ConnectScreen', () => {
  it('scans, lists both ankles with RSSI and connects both', async () => {
    const h = makeHarness();
    await render(<ConnectScreen requestPermissions={async () => 'granted'} />, {
      wrapper: h.wrapper,
    });
    expect(screen.getByTestId('replay-banner')).toBeOnTheScreen();
    expect(screen.getByTestId('state-L')).toHaveTextContent('Not connected');
    await h.advance(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Scan' }));
    await h.advance(0);
    expect(screen.getByText('ArcSense-L')).toBeOnTheScreen();
    expect(screen.getByText('ArcSense-R')).toBeOnTheScreen();
    expect(screen.getAllByText(/dBm/)).toHaveLength(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Connect both' }));
    await h.advance(200);
    expect(screen.getByTestId('state-L')).toHaveTextContent('Connected');
    expect(screen.getByTestId('state-R')).toHaveTextContent('Connected');
    expect(screen.getAllByText('Firmware mode: STREAMING')).toHaveLength(2);
    await fireEvent.press(screen.getByTestId('disconnect-L'));
    await h.advance(0);
    expect(screen.getByTestId('state-L')).toHaveTextContent('Not connected');
    expect(screen.getByRole('button', { name: /Reconnect ArcSense-L/ })).toBeOnTheScreen();
  });

  it('shows reconnecting state after a link drop', async () => {
    const h = makeHarness();
    await render(<ConnectScreen requestPermissions={async () => 'granted'} />, {
      wrapper: h.wrapper,
    });
    await h.advance(0);
    await h.connectBoth();
    (h.services.transport as import('@/ble/MockTransport').MockTransport).dropLink('replay-R');
    await h.advance(0);
    expect(screen.getByTestId('state-R')).toHaveTextContent('Reconnecting… (try 1)');
    await h.advance(1100);
    expect(screen.getByTestId('state-R')).toHaveTextContent('Connected');
  });

  it('blocks scanning and offers Settings when permission is blocked', async () => {
    const h = makeHarness({ mode: 'ble' });
    await render(<ConnectScreen requestPermissions={async () => 'blocked'} />, {
      wrapper: h.wrapper,
    });
    await h.advance(0);
    expect(screen.getByTestId('adapter-banner')).toHaveTextContent(/blocked/);
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
    expect(screen.queryByTestId('replay-banner')).not.toBeOnTheScreen();
  });
});
