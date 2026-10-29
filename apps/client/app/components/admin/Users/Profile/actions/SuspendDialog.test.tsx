import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReinstateDialog, SuspendDialog } from './SuspendDialog';
import { LiveProfile, ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('./useAdminUserUpdate', () => ({ useAdminUserUpdate: () => mocks.update }));

const setup = (credits = 500) => {
  const onClose = vi.fn();
  render(<SuspendDialog user={buildProfile({ currentCredits: credits })} onClose={onClose} />, {
    wrapper: ProfileTestWrapper,
  });
  return { onClose };
};

const pickReason = () => fireEvent.click(screen.getByTestId('suspend-dialog-reason-input-preset-0'));
const confirmButton = () => screen.getByTestId('suspend-dialog-confirm-btn');

describe('SuspendDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue(undefined);
  });

  it('names the user and blocks until a reason is given', () => {
    setup();

    expect(screen.getByRole('dialog', { name: 'Suspend Ada Lovelace?' })).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('suspend-dialog-hint')).toHaveTextContent(
      'Pick a reason or write at least 5 characters.'
    );
  });

  it('sends only isBanned: true when credits are left alone', async () => {
    const { onClose } = setup();
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        isBanned: true,
        statusChangeReason: 'Abuse / automated signups',
      })
    );
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Account suspended');
  });

  it('also zeroes credits with the reason when the checkbox is ticked', async () => {
    setup();
    fireEvent.click(screen.getByTestId('suspend-dialog-zero-credits-checkbox'));
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        isBanned: true,
        statusChangeReason: 'Abuse / automated signups',
        currentCredits: 0,
        creditReason: 'Abuse / automated signups',
      })
    );
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Account suspended, credits set to 0');
  });

  it('offers no credit wipe when the balance is already 0', async () => {
    setup(0);

    expect(screen.queryByTestId('suspend-dialog-zero-credits-checkbox')).not.toBeInTheDocument();
    pickReason();
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        isBanned: true,
        statusChangeReason: 'Abuse / automated signups',
      })
    );
  });

  it('undo reinstates without refunding when nothing was removed', async () => {
    setup();
    pickReason();
    fireEvent.click(confirmButton());
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        isBanned: false,
        statusChangeReason: 'Undo: Abuse / automated signups',
      })
    );
  });

  it('undo reinstates and gives back exactly the credits it removed', async () => {
    setup();
    fireEvent.click(screen.getByTestId('suspend-dialog-zero-credits-checkbox'));
    pickReason();
    fireEvent.click(confirmButton());
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        isBanned: false,
        statusChangeReason: 'Undo: Abuse / automated signups',
        creditDelta: 500,
        creditReason: 'Undo: Abuse / automated signups',
      })
    );
  });

  it('stays open when the write fails', async () => {
    mocks.update.mockRejectedValue(new Error('nope'));
    const { onClose } = setup();
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('refetches the balance on open and holds confirm until it lands, so the wipe and undo use it', async () => {
    let resolveRefetch: (credits: number) => void = () => undefined;
    const fetchCredits = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(500)
      .mockImplementationOnce(() => new Promise(resolve => (resolveRefetch = resolve)));
    render(
      <LiveProfile fetchCredits={fetchCredits}>{live => <SuspendDialog user={live} onClose={vi.fn()} />}</LiveProfile>,
      { wrapper: ProfileTestWrapper }
    );
    await waitFor(() => expect(fetchCredits).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('suspend-dialog-zero-credits-checkbox'));
    pickReason();
    fireEvent.click(confirmButton());
    expect(mocks.update).not.toHaveBeenCalled();

    resolveRefetch(320);
    expect(await screen.findByText('Removes 320 credits.')).toBeInTheDocument();
    fireEvent.click(confirmButton());
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        isBanned: false,
        statusChangeReason: 'Undo: Abuse / automated signups',
        creditDelta: 320,
        creditReason: 'Undo: Abuse / automated signups',
      })
    );
  });

  it('blocks only the credit wipe when the balance could not be refreshed', async () => {
    const fetchCredits = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(500)
      .mockRejectedValueOnce(new Error('network'));
    render(
      <LiveProfile fetchCredits={fetchCredits}>{live => <SuspendDialog user={live} onClose={vi.fn()} />}</LiveProfile>,
      { wrapper: ProfileTestWrapper }
    );
    await waitFor(() => expect(fetchCredits).toHaveBeenCalledTimes(2));
    pickReason();
    await waitFor(() => expect(confirmButton()).toBeEnabled());

    fireEvent.click(screen.getByTestId('suspend-dialog-zero-credits-checkbox'));

    expect(screen.getByTestId('suspend-dialog-hint')).toHaveTextContent('The current balance could not be loaded.');
    expect(confirmButton()).toBeDisabled();
  });
});

describe('ReinstateDialog', () => {
  const setupReinstate = () => {
    const onClose = vi.fn();
    render(<ReinstateDialog user={buildProfile({ isBanned: true })} onClose={onClose} />, {
      wrapper: ProfileTestWrapper,
    });
    return { onClose };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue(undefined);
  });

  it('names the user and blocks until a reason is given', () => {
    setupReinstate();

    expect(screen.getByRole('dialog', { name: 'Reinstate Ada Lovelace?' })).toBeInTheDocument();
    expect(screen.getByTestId('reinstate-dialog-confirm-btn')).toBeDisabled();
  });

  it('sends isBanned: false with the reason, and undo re-suspends under an Undo reason', async () => {
    const { onClose } = setupReinstate();
    fireEvent.click(screen.getByTestId('reinstate-dialog-reason-input-preset-0'));

    fireEvent.click(screen.getByTestId('reinstate-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ isBanned: false, statusChangeReason: 'Suspended in error' })
    );
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Account reinstated');

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({
        isBanned: true,
        statusChangeReason: 'Undo: Suspended in error',
      })
    );
  });

  it('stays open when the write fails', async () => {
    mocks.update.mockRejectedValue(new Error('nope'));
    const { onClose } = setupReinstate();
    fireEvent.click(screen.getByTestId('reinstate-dialog-reason-input-preset-0'));

    fireEvent.click(screen.getByTestId('reinstate-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
