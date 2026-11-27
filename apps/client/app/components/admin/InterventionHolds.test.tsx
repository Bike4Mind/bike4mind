import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { InterventionDecisionsPanel, InterventionHoldsCard, holdStatus } from './InterventionHolds';
import { ProfileTestWrapper } from './Users/Profile/profileTestUtils';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));

const HOUR_MS = 3_600_000;
const future = () => new Date(Date.now() + HOUR_MS).toISOString();
const past = () => new Date(Date.now() - HOUR_MS).toISOString();

const hold = (over: Record<string, unknown> = {}) => ({
  decisionId: 'decision-1',
  detectionId: 'detection-1',
  tier: 'review',
  policyVersion: 1,
  reason: 'Automated review (policy v1)',
  appliedAt: past(),
  expiresAt: future(),
  releasedAt: null,
  releasedBy: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReset();
  mocks.post.mockReset().mockResolvedValue({ data: { released: [] } });
});

describe('holdStatus', () => {
  it('separates active, admin-released and expired holds', () => {
    const now = Date.now();
    expect(holdStatus(hold(), now)).toBe('active');
    expect(holdStatus(hold({ expiresAt: past() }), now)).toBe('expired');
    expect(holdStatus(hold({ releasedAt: past(), releasedBy: 'expiry' }), now)).toBe('expired');
    expect(holdStatus(hold({ releasedAt: past(), releasedBy: 'admin-1' }), now)).toBe('released');
  });
});

describe('InterventionHoldsCard', () => {
  it('renders nothing when the account has no automated holds', async () => {
    mocks.get.mockResolvedValue({ data: { data: [] } });
    render(<InterventionHoldsCard userId="subject" />, { wrapper: ProfileTestWrapper });
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(screen.queryByTestId('user-intervention-holds')).toBeNull();
  });

  it('shows an active hold expiry as a future time', async () => {
    mocks.get.mockResolvedValue({
      data: { data: [hold({ expiresAt: new Date(Date.now() + 3 * 24 * HOUR_MS + 60_000).toISOString() })] },
    });
    render(<InterventionHoldsCard userId="subject" />, { wrapper: ProfileTestWrapper });

    expect(await screen.findByTestId('user-intervention-hold-expires')).toHaveTextContent(/^Expires in 3 days$/);
  });

  it.each([
    {
      userIds: [],
      skippedUserIds: ['subject'],
      message: 'No holds released: 1 account could not be released',
      kind: 'error',
      staysOpen: true,
    },
    { userIds: [], skippedUserIds: [], message: 'No active holds were released', kind: 'info', staysOpen: true },
    {
      userIds: ['other'],
      skippedUserIds: ['subject'],
      message: 'Released holds for 1 account; 1 account could not be released',
      kind: 'warning',
      staysOpen: true,
    },
    { userIds: ['subject'], skippedUserIds: [], message: 'Hold released', kind: 'success', staysOpen: false },
  ] as const)(
    'reports the actual release response: $kind',
    async ({ userIds, skippedUserIds, message, kind, staysOpen }) => {
      mocks.get.mockResolvedValue({ data: { data: [hold()] } });
      mocks.post.mockResolvedValue({ data: { released: [{ decisionId: 'decision-1', userIds, skippedUserIds }] } });
      render(<InterventionHoldsCard userId="subject" />, { wrapper: ProfileTestWrapper });
      fireEvent.click(await screen.findByTestId('user-intervention-hold-release-btn'));
      fireEvent.click(screen.getByTestId('user-intervention-release-dialog-reason-input-preset-0'));
      fireEvent.click(screen.getByTestId('user-intervention-release-dialog-confirm-btn'));
      await waitFor(() => expect(toast[kind]).toHaveBeenCalledWith(message));
      if (kind !== 'success') expect(toast.success).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(Boolean(screen.queryByTestId('user-intervention-release-dialog-confirm-btn'))).toBe(staysOpen)
      );
    }
  );

  it('offers Release only on an active hold and posts that decision with the reason', async () => {
    mocks.get.mockResolvedValue({
      data: { data: [hold(), hold({ decisionId: 'decision-2', tier: 'limit', expiresAt: past() })] },
    });
    render(<InterventionHoldsCard userId="subject" />, { wrapper: ProfileTestWrapper });

    expect(await screen.findAllByTestId('user-intervention-hold-row')).toHaveLength(2);
    const buttons = screen.getAllByTestId('user-intervention-hold-release-btn');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    fireEvent.click(screen.getByTestId('user-intervention-release-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-intervention-release-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/users/subject/interventions', {
        decisionId: 'decision-1',
        reason: expect.any(String),
      })
    );
  });
});

describe('InterventionDecisionsPanel', () => {
  it('lists the detection decisions with tier and policy version, and no Release on a Contain decision', async () => {
    mocks.get.mockResolvedValue({
      data: {
        data: [
          {
            id: 'd1',
            tier: 'contain',
            policyVersion: null,
            reason: 'Contained',
            expiresAt: null,
            outcome: 'contained',
          },
          { id: 'd2', tier: 'verify', policyVersion: 1, reason: 'Verify', expiresAt: future(), outcome: 'intervened' },
        ],
      },
    });
    render(<InterventionDecisionsPanel detectionId="detection-1" />, { wrapper: ProfileTestWrapper });

    expect(await screen.findAllByTestId('detection-intervention-decision-row')).toHaveLength(2);
    expect(screen.getByText('Require verification')).toBeTruthy();
    expect(screen.getByText(/policy v1/)).toBeTruthy();
    expect(screen.getAllByTestId('detection-intervention-decision-release-btn')).toHaveLength(1);
  });
});
