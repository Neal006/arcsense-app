import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { makeHarness } from '@/testing/appHarness';

import { SessionScreen } from '../SessionScreen';

jest.mock('@/db/open', () => ({ openRepository: () => null }));
jest.mock('@/ble/PlxTransport', () => ({ PlxTransport: jest.fn() }));
jest.mock('@/export/share', () => ({ exportAndShare: jest.fn() }));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));
jest.mock('expo-haptics', () => ({ selectionAsync: jest.fn(async () => undefined) }));

const confirmNow = (_t: string, _m: string, ok: () => void) => ok();

async function fillForm() {
  await fireEvent.changeText(screen.getByLabelText('Subject code (no names)'), 'P014');
  await fireEvent.changeText(screen.getByLabelText('Condition / trial type'), '10 m walk');
  await fireEvent.changeText(screen.getByLabelText('Operator'), 'op');
}

describe('SessionScreen', () => {
  it('explains why Start is disabled until the form is valid and both ankles are connected', async () => {
    const h = makeHarness();
    await render(<SessionScreen confirm={confirmNow} haptic={() => undefined} />, {
      wrapper: h.wrapper,
    });
    expect(screen.getByRole('button', { name: 'Start session' })).toBeDisabled();
    expect(screen.getByTestId('start-problems')).toHaveTextContent(/Subject code is required/);
    expect(screen.getByTestId('start-problems')).toHaveTextContent(/Connect L and R first/);
    await fireEvent.changeText(screen.getByLabelText('Subject code (no names)'), 'John Smith');
    expect(screen.getByTestId('start-problems')).toHaveTextContent(/no names/);
    await fillForm();
    await h.connectBoth();
    expect(screen.queryByTestId('start-problems')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
  });

  it('runs a full annotated session and shows the summary and export', async () => {
    const share = jest.fn(async () => 'file://x.zip');
    const haptic = jest.fn();
    const h = makeHarness();
    await h.connectBoth();
    await render(<SessionScreen confirm={confirmNow} haptic={haptic} share={share} />, {
      wrapper: h.wrapper,
    });
    await fillForm();
    await fireEvent.press(screen.getByRole('button', { name: 'Start session' }));
    await h.advance(0);
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Sync 0xAA01 · 1 sent');
    expect(screen.getByTestId('timer')).toHaveTextContent('00:00:00');

    await fireEvent.press(screen.getByRole('button', { name: 'Start Normal walk' }));
    await h.advance(0);
    expect(haptic).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'End Normal walk' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Start Shuffling' })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Start FoG episode' }));
    await h.advance(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Turn' }));
    await h.advance(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Void "Turn"' }));
    await h.advance(0);
    expect(screen.getByRole('button', { name: 'Void "FoG episode"' })).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByLabelText('Note'), 'freezing at doorway');
    await fireEvent.press(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByText('• freezing at doorway')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Sync now' }));
    await h.advance(0);
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Sync 0xAA02 · 2 sent');

    await fireEvent.press(screen.getByRole('button', { name: 'Stop session' }));
    await h.advance(0);
    expect(screen.getByTestId('summary')).toHaveTextContent(
      /3 sync tokens \(0 partial\) · 5 labels \(1 voided\)/,
    );
    expect(screen.getByText('2 open episode(s) were closed at stop.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Export' }));
    expect(share).toHaveBeenCalledWith(h.repo, expect.stringMatching(/^P014_/));
    await fireEvent.press(screen.getByRole('button', { name: 'New session' }));
    expect(screen.getByRole('button', { name: 'Start session' })).toBeOnTheScreen();
  });

  it('warns when the last sync reached only one ankle', async () => {
    const h = makeHarness();
    await h.connectBoth();
    await render(<SessionScreen confirm={confirmNow} haptic={() => undefined} />, {
      wrapper: h.wrapper,
    });
    await fillForm();
    await fireEvent.press(screen.getByRole('button', { name: 'Start session' }));
    await h.advance(0);
    const t = h.services.transport as import('@/ble/MockTransport').MockTransport;
    t.setAdvertising('replay-R', false);
    t.dropLink('replay-R');
    await fireEvent.press(screen.getByRole('button', { name: 'Sync now' }));
    await h.advance(0);
    expect(screen.getByTestId('partial-banner')).toBeOnTheScreen();
  });

  it('offers to resume or close a session left unfinished by an app kill', async () => {
    const first = makeHarness();
    await first.connectBoth();
    await act(() =>
      first.services.recorder
        .start({
          subjectCode: 'P001',
          condition: 'walk',
          operator: 'op',
          notes: '',
          plannedSides: 'LR',
          affectedSide: null,
        })
        .then(() => undefined),
    );
    first.unbind();

    const second = makeHarness({ repo: first.repo });
    await render(<SessionScreen confirm={confirmNow} haptic={() => undefined} />, {
      wrapper: second.wrapper,
    });
    expect(screen.getByText('Unfinished session')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Close it' }));
    expect(screen.queryByText('Unfinished session')).not.toBeOnTheScreen();
    expect(first.repo.listSessions()[0]!.status).toBe('aborted');
  });

  it('resumes an unfinished session into the running view', async () => {
    const first = makeHarness();
    await first.connectBoth();
    await act(() =>
      first.services.recorder
        .start({
          subjectCode: 'P001',
          condition: 'walk',
          operator: 'op',
          notes: '',
          plannedSides: 'LR',
          affectedSide: null,
        })
        .then(() => undefined),
    );
    first.unbind();
    const second = makeHarness({ repo: first.repo });
    await second.connectBoth();
    await render(<SessionScreen confirm={confirmNow} haptic={() => undefined} />, {
      wrapper: second.wrapper,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Resume' }));
    await second.advance(0);
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Sync 0xAA02 · 1 sent');
  });
});
