import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUser } from '@client/app/contexts/UserContext';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReinstateDialog, SuspendDialog } from './SuspendDialog';
import { LiveProfile, ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({ update: vi.fn(), toastWarning: vi.fn() }));

vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning, error: vi.fn(), success: vi.fn() } }));
vi.mock('./useAdminUserUpdate', () => ({ useAdminUserUpdate: () => mocks.update }));
vi.mock('@client/app/hooks/data/settings', () => ({
  usePublicConfig: () => ({ data: { supportEmail: 'support@example.com' } }),
}));

const setup = (credits = 500) => {
  const onClose = vi.fn();
  render(<SuspendDialog user={buildProfile({ currentCredits: credits })} onClose={onClose} />, {
    wrapper: ProfileTestWrapper,
  });
  return { onClose };
};

const pickCategory = () => {
  fireEvent.mouseDown(screen.getByTestId('suspend-dialog-category-select'));
  fireEvent.click(screen.getByTestId('suspend-dialog-category-option-multiple_accounts'));
};
const pickReason = () => {
  fireEvent.click(screen.getByTestId('suspend-dialog-reason-input-preset-0'));
  pickCategory();
};
const confirmButton = () => screen.getByTestId('suspend-dialog-confirm-btn');

describe('SuspendDialog', () => {
  beforeEach(() => {
    useUser.setState({ currentUser: { id: 'admin-1', isAdmin: true } as never });
    vi.clearAllMocks();
    mocks.update.mockResolvedValue(undefined);
  });

  it('warns when the suspend could not cancel every subscription, and stays quiet otherwise', async () => {
    mocks.update.mockResolvedValue({
      subscriptionCancellation: {
        canceled: ['sub_a'],
        failed: [{ customerId: 'cus_1', subscriptionId: 'sub_b', reason: 'stripe down' }],
      },
    });
    const { onClose } = setup();
    pickReason();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'Could not cancel 1 Stripe subscription(s) of this account. Cancel them in Stripe.'
    );
  });

  it('shows no warning when every subscription was canceled', async () => {
    mocks.update.mockResolvedValue({ subscriptionCancellation: { canceled: ['sub_a'], failed: [] } });
    const { onClose } = setup();
    pickReason();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it('names the user and blocks until a reason is given', () => {
    setup();

    expect(screen.getByRole('dialog', { name: 'Suspend Ada Lovelace?' })).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('suspend-dialog-hint')).toHaveTextContent('Choose the reason the user is told.');

    pickCategory();

    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('suspend-dialog-hint')).toHaveTextContent(
      'Pick a reason or write at least 5 characters.'
    );
  });

  it('cannot suspend until the user-facing reason category is chosen, and previews what the user sees', async () => {
    setup();
    fireEvent.click(screen.getByTestId('suspend-dialog-reason-input-preset-0'));
    expect(confirmButton()).toBeDisabled();

    pickCategory();

    expect(confirmButton()).toBeEnabled();
    expect(screen.getByTestId('suspend-dialog-category-preview')).toHaveTextContent(
      'This account is suspended for using multiple accounts to obtain free credits'
    );
    expect(screen.getByTestId('suspend-dialog-category-preview')).toHaveTextContent(
      'you can appeal by emailing support@example.com'
    );
  });

  it('sends only isBanned: true when credits are left alone', async () => {
    const { onClose } = setup();
    expect(screen.getByTestId('suspend-dialog')).toHaveTextContent('stay canceled if you undo or reinstate');
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        isBanned: true,
        suspensionReasonCategory: 'multiple_accounts',
        statusChangeReason: 'Abuse / automated signups',
      })
    );
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent(
      'Account suspended. Undo does not restore canceled subscriptions.'
    );
  });

  it('also zeroes credits with the reason when the checkbox is ticked', async () => {
    setup();
    fireEvent.click(screen.getByTestId('suspend-dialog-zero-credits-checkbox'));
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        isBanned: true,
        suspensionReasonCategory: 'multiple_accounts',
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
        suspensionReasonCategory: 'multiple_accounts',
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
        undoSuspension: true,
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
        undoSuspension: true,
        creditDelta: 500,
        creditReason: 'Undo: Abuse / automated signups',
      })
    );
  });

  it('offers the credit wipe to a delegate only as a disabled option', async () => {
    useUser.setState({ currentUser: { id: 'd1', isAdmin: false, adminPermissions: ['users:moderate'] } as never });
    setup();
    await waitFor(() => expect(screen.getByTestId('suspend-dialog-zero-credits-checkbox')).toBeDisabled());
    expect(screen.getByText('Only full administrators can change credits while suspending.')).toBeInTheDocument();
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
        undoSuspension: true,
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
