import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SuspendDialog } from './SuspendDialog';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';

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

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ isBanned: true }));
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

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ isBanned: true }));
  });

  it('undo reinstates without refunding when nothing was removed', async () => {
    setup();
    pickReason();
    fireEvent.click(confirmButton());
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith({ isBanned: false }));
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
});
