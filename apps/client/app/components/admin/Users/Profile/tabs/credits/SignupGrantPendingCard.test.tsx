import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSignupGrantPending } from '@bike4mind/common';
import { ProfileTestWrapper, buildProfile } from '../../profileTestUtils';
import { SignupGrantPendingCard } from './SignupGrantPendingCard';

const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  mutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/data/adminSignupGrant', () => ({
  useAdminSignupGrantPending: mocks.pending,
  useAdminSignupGrantAction: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, info: mocks.toastInfo, error: mocks.toastError },
}));

const available = { available: true, reason: null, permitted: true };
const unavailable = (reason: string) => ({ available: false, reason, permitted: true });

const GRANTED: AdminSignupGrantPending = {
  hasGrant: true,
  source: 'default',
  stage: 'signup',
  schedule: {
    signupCredits: 100,
    unlockCredits: 900,
    received: 300,
    dripped: 200,
    dripCap: 900,
    dailyCredits: 50,
    remaining: 700,
    dripRemaining: 700,
  },
  held: null,
  heldUnlock: null,
  forfeited: null,
  blocked: null,
  rewards: { queuedCount: 2, queuedCredits: 40, pausedCount: 0, pausedCredits: 0 },
  lastActivityCreditDay: '2026-11-03',
  actions: {
    releaseHeld: unavailable('not_held'),
    releaseRemaining: available,
    block: available,
    unblock: unavailable('not_blocked'),
  },
};

const NO_GRANT: AdminSignupGrantPending = {
  ...GRANTED,
  hasGrant: false,
  source: null,
  stage: null,
  schedule: null,
  rewards: { queuedCount: 0, queuedCredits: 0, pausedCount: 0, pausedCredits: 0 },
  lastActivityCreditDay: null,
  actions: {
    releaseHeld: unavailable('no_grant'),
    releaseRemaining: unavailable('no_grant'),
    block: unavailable('no_grant'),
    unblock: unavailable('no_grant'),
  },
};

const ready = (data: AdminSignupGrantPending) =>
  mocks.pending.mockReturnValue({ data, isLoading: false, isError: false, refetch: vi.fn() });

const renderCard = () =>
  render(
    <ProfileTestWrapper>
      <SignupGrantPendingCard user={buildProfile()} />
    </ProfileTestWrapper>
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutateAsync.mockResolvedValue({ outcome: 'applied', credits: 700 });
});

describe('SignupGrantPendingCard', () => {
  it('shows the schedule, remaining-to-drip and queued rewards of a granted account', () => {
    ready(GRANTED);
    renderCard();
    expect(screen.getByTestId('pending-credits-stage')).toHaveTextContent('Signup tranche paid');
    expect(screen.getByTestId('pending-credits-received')).toHaveTextContent('300 of 1,000');
    expect(screen.getByTestId('pending-credits-drip-remaining')).toHaveTextContent('700');
    expect(screen.getByTestId('pending-credits-rewards')).toHaveTextContent('2 (40 credits)');
    expect(screen.getByTestId('user-pending-releaseRemaining-btn')).toBeInTheDocument();
    expect(screen.getByTestId('user-pending-block-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('user-pending-unblock-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-pending-releaseHeld-btn')).not.toBeInTheDocument();
  });

  it('offers only unblock on a blocked account and shows its paused rewards', () => {
    ready({
      ...GRANTED,
      blocked: { at: '2026-11-04T09:00:00.000Z' },
      rewards: { queuedCount: 0, queuedCredits: 0, pausedCount: 2, pausedCredits: 40 },
      actions: {
        releaseHeld: unavailable('blocked'),
        releaseRemaining: unavailable('blocked'),
        block: unavailable('already_blocked'),
        unblock: available,
      },
    });
    renderCard();
    expect(screen.getByTestId('pending-credits-chip-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('pending-credits-paused-rewards')).toHaveTextContent('2 (40 credits)');
    expect(screen.getByTestId('user-pending-unblock-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('user-pending-block-btn')).not.toBeInTheDocument();
  });

  it('shows a held tranche and its release', () => {
    ready({
      ...GRANTED,
      held: { reason: 'budget_exhausted', since: '2026-11-04T10:00:00.000Z', credits: 100 },
      actions: { ...GRANTED.actions, releaseHeld: available },
    });
    renderCard();
    expect(screen.getByTestId('pending-credits-chip-held')).toBeInTheDocument();
    expect(screen.getByTestId('pending-credits-held')).toHaveTextContent('100 credits, waiting for the daily pool');
    expect(screen.getByTestId('user-pending-releaseHeld-btn')).toBeInTheDocument();
  });

  it('marks a grant package account', () => {
    ready({ ...GRANTED, source: 'package' });
    renderCard();
    expect(screen.getByTestId('pending-credits-chip-package')).toBeInTheDocument();
  });

  it('explains that an account with no signup grant cannot be blocked and offers no actions', () => {
    ready(NO_GRANT);
    renderCard();
    expect(screen.getByTestId('pending-credits-chip-no-grant')).toBeInTheDocument();
    expect(screen.getByTestId('user-pending-block-note')).toHaveTextContent('Cannot block');
    expect(screen.queryByTestId('user-pending-block-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-pending-releaseRemaining-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-credits-rewards')).toHaveTextContent('None');
  });

  it('says why release-remaining is unavailable while the first tranche is pending', () => {
    ready({
      ...GRANTED,
      stage: 'pending_email',
      actions: { ...GRANTED.actions, releaseRemaining: unavailable('tranche_pending') },
    });
    renderCard();
    expect(screen.getByTestId('user-pending-releaseRemaining-note')).toHaveTextContent(
      'first tranche is still pending'
    );
    expect(screen.queryByTestId('user-pending-releaseRemaining-btn')).not.toBeInTheDocument();
  });

  it('hides release-remaining from a delegated admin', () => {
    ready({
      ...GRANTED,
      actions: { ...GRANTED.actions, releaseRemaining: { available: true, reason: null, permitted: false } },
    });
    renderCard();
    expect(screen.queryByTestId('user-pending-releaseRemaining-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-pending-block-btn')).toBeInTheDocument();
  });

  it('runs an action with the picked reason and reports the credits released', async () => {
    ready(GRANTED);
    renderCard();
    fireEvent.click(screen.getByTestId('user-pending-releaseRemaining-btn'));
    fireEvent.click(screen.getByTestId('user-pending-releaseRemaining-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-pending-releaseRemaining-dialog-confirm-btn'));
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
        action: 'releaseRemaining',
        reason: 'Goodwill grant',
      })
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('700 credits released'));
    await waitFor(() => expect(screen.queryByTestId('user-pending-releaseRemaining-dialog')).not.toBeInTheDocument());
  });

  it('explains a no-op instead of reporting success', async () => {
    mocks.mutateAsync.mockResolvedValue({ outcome: 'noop', reason: 'already_blocked' });
    ready(GRANTED);
    renderCard();
    fireEvent.click(screen.getByTestId('user-pending-block-btn'));
    fireEvent.click(screen.getByTestId('user-pending-block-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-pending-block-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith('This account is already blocked.'));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and toasts when the action fails', async () => {
    mocks.mutateAsync.mockRejectedValue(new Error('boom'));
    ready(GRANTED);
    renderCard();
    fireEvent.click(screen.getByTestId('user-pending-block-btn'));
    fireEvent.click(screen.getByTestId('user-pending-block-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-pending-block-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Block failed. Try again.'));
    expect(screen.getByTestId('user-pending-block-dialog')).toBeInTheDocument();
  });

  it('shows a loading line and an error with retry', () => {
    mocks.pending.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    const { unmount } = renderCard();
    expect(screen.getByTestId('user-pending-loading')).toBeInTheDocument();
    unmount();

    const refetch = vi.fn();
    mocks.pending.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    renderCard();
    expect(screen.getByText('Pending credits could not be loaded.')).toBeInTheDocument();
  });
});
