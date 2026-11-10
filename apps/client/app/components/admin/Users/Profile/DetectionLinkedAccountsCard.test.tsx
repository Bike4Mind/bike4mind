import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { UserDetectionLinks } from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';
import { DetectionLinkedAccountsCard } from './DetectionLinkedAccountsCard';
import { ProfileTestWrapper } from './profileTestUtils';

const mocks = vi.hoisted(() => ({
  links: vi.fn(),
  updateUser: vi.fn(),
  toastError: vi.fn(),
  post: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: mocks.toastError, success: vi.fn() } }));
vi.mock('@client/app/hooks/data/adminUserTimeline', () => ({ useUserDetectionLinks: () => mocks.links() }));
vi.mock('@client/app/utils/userAPICalls', () => ({ updateUserToServer: mocks.updateUser }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.post } }));
vi.mock('./useOpenUserProfile', () => ({ useOpenUserProfile: () => vi.fn() }));

const account = (
  id: string,
  overrides: Partial<UserDetectionLinks['accounts'][number]> = {}
): UserDetectionLinks['accounts'][number] => ({
  id,
  name: `Account ${id}`,
  email: `${id}@example.com`,
  signedUpAt: new Date('2026-11-07T00:00:00Z'),
  blocked: false,
  isBanned: false,
  balance: 400,
  spent: 1600,
  activeApiKeys: 1,
  detectionIds: ['d1'],
  ...overrides,
});

const LINKS: UserDetectionLinks = {
  detections: [
    {
      id: 'd1',
      detector: 'accountCampaign',
      summary: '3 accounts linked on network and lifecycle',
      detectedAt: new Date('2026-11-08T00:00:00Z'),
      verdict: null,
      accountCount: 4,
    },
  ],
  accounts: [account('one'), account('two'), account('gone', { isBanned: true, blocked: true, activeApiKeys: 0 })],
  truncated: false,
};

const setup = (data: UserDetectionLinks | undefined = LINKS) => {
  mocks.links.mockReturnValue({ data, isLoading: false, isError: false, refetch: vi.fn() });
  return render(<DetectionLinkedAccountsCard userId="subject" />, { wrapper: ProfileTestWrapper });
};

const openDialog = () => {
  fireEvent.click(screen.getByTestId('detection-links-suspend-all-btn'));
  fireEvent.click(screen.getByTestId('suspend-linked-dialog-reason-input-preset-0'));
};

describe('DetectionLinkedAccountsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateUser.mockResolvedValue({});
    mocks.post.mockResolvedValue({ data: { locked: [], review: [] } });
  });

  it('renders nothing when no cohort detection names the user', () => {
    const { container } = setup({ detections: [], accounts: [], truncated: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('lists linked accounts with spend, balance and live keys, and the detection that links them', () => {
    setup();
    expect(screen.getByTestId('detection-links-detections')).toHaveTextContent('Account campaign');
    expect(screen.getByTestId('detection-links-detections')).toHaveTextContent('Unreviewed');
    const row = screen.getByTestId('detection-links-row-one');
    expect(row).toHaveTextContent('1,600');
    expect(row).toHaveTextContent('400');
    expect(screen.getByTestId('detection-links-row-gone')).toHaveTextContent('Suspended');
    expect(screen.getByTestId('detection-links-suspend-all-btn')).toHaveTextContent('Suspend all linked (2)');
  });

  it('confirms once, listing the accounts, then suspends each active one through the single-account path', async () => {
    setup();
    openDialog();
    const list = screen.getByTestId('suspend-linked-dialog-accounts');
    expect(within(list).getByText('Account one')).toBeInTheDocument();
    expect(within(list).getByText('Account two')).toBeInTheDocument();
    expect(within(list).queryByText('Account gone')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('suspend-linked-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledTimes(2));
    expect(mocks.updateUser).toHaveBeenNthCalledWith(1, 'one', {
      isBanned: true,
      statusChangeReason: 'Abuse / automated signups',
      deferLinkPropagation: true,
    });
    expect(mocks.updateUser).toHaveBeenNthCalledWith(2, 'two', {
      isBanned: true,
      statusChangeReason: 'Abuse / automated signups',
      deferLinkPropagation: true,
    });
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('2 linked accounts suspended.');
    // One linked-account check for the whole action, not one per account.
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/users/linked-suspend-propagation', {
      userIds: ['one', 'two'],
    });
  });

  it('undoes by reinstating each account as an undo, so the suspend grades are removed rather than flipped', async () => {
    setup();
    openDialog();
    fireEvent.click(screen.getByTestId('suspend-linked-dialog-confirm-btn'));
    await screen.findByTestId('undo-toast-message');

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledTimes(4));
    for (const id of ['one', 'two']) {
      expect(mocks.updateUser).toHaveBeenCalledWith(id, {
        isBanned: false,
        statusChangeReason: 'Undo: Abuse / automated signups',
        undoSuspension: true,
      });
    }
  });

  it('keeps Undo open on a failed reinstate and retries only that account', async () => {
    setup();
    openDialog();
    fireEvent.click(screen.getByTestId('suspend-linked-dialog-confirm-btn'));
    await screen.findByTestId('undo-toast-message');
    mocks.updateUser.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('network'));

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    expect(await screen.findByTestId('undo-toast-error')).toHaveTextContent(
      '1 of 2 accounts were not reinstated. Undo again to retry them.'
    );
    expect(screen.getByTestId('undo-toast')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('undo-toast-undo-btn')).toBeEnabled());

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    await waitFor(() => expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument());
    expect(mocks.updateUser).toHaveBeenCalledTimes(5);
    expect(mocks.updateUser).toHaveBeenLastCalledWith('two', {
      isBanned: false,
      statusChangeReason: 'Undo: Abuse / automated signups',
      undoSuspension: true,
    });
  });

  it('stops at Cancel, then still refreshes, alerts once and offers Undo for the accounts already sent', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    let resolveSuspend!: (value: object) => void;
    mocks.updateUser.mockReturnValueOnce(
      new Promise(resolve => {
        resolveSuspend = resolve;
      })
    );
    setup();
    openDialog();
    fireEvent.click(screen.getByTestId('suspend-linked-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('suspend-linked-dialog-cancel-btn'));
    expect(screen.queryByTestId('suspend-linked-dialog')).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();

    await act(async () => resolveSuspend({}));

    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent(
      'Canceled: 1 of 2 linked accounts were suspended before you canceled.'
    );
    // The account not yet sent when the admin canceled is left alone.
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).toHaveBeenCalledWith('one', expect.objectContaining({ isBanned: true }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/users/linked-suspend-propagation', { userIds: ['one'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'users'] });
    expect(mocks.toastError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledTimes(2));
    expect(mocks.updateUser).toHaveBeenLastCalledWith('one', expect.objectContaining({ isBanned: false }));
    invalidate.mockRestore();
  });

  it('words a one-account run in the singular', () => {
    setup({ ...LINKS, accounts: [account('one')] });
    openDialog();
    expect(screen.getByText('Suspend 1 linked account?')).toBeInTheDocument();
    expect(screen.getByTestId('suspend-linked-dialog-confirm-btn')).toHaveTextContent(/^Suspend 1 account$/);
  });

  it('keeps the dialog open on a partial failure and retries only the accounts that failed', async () => {
    mocks.updateUser.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('network'));
    setup();
    openDialog();

    fireEvent.click(screen.getByTestId('suspend-linked-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.getByTestId('suspend-linked-dialog')).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('suspend-linked-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledTimes(3));
    expect(mocks.updateUser).toHaveBeenLastCalledWith('two', expect.objectContaining({ isBanned: true }));
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('2 linked accounts suspended.');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/users/linked-suspend-propagation', {
      userIds: ['one', 'two'],
    });
  });

  it('still sends one linked-account check when the admin closes after a partial failure', async () => {
    mocks.updateUser.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('network'));
    setup();
    openDialog();
    fireEvent.click(screen.getByTestId('suspend-linked-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('suspend-linked-dialog-cancel-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/users/linked-suspend-propagation', { userIds: ['one'] });
  });
});
