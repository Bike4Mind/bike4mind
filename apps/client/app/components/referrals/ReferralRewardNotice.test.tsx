import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useGetReferralSummary, toastSuccess } = vi.hoisted(() => ({
  useGetReferralSummary: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', async () => {
  const { create } = await import('zustand');
  return { useUser: create(() => ({ currentUser: { id: 'u1', regInvites: ['inv1'] } })) };
});
vi.mock('@client/app/hooks/data/referralSummary', () => ({ useGetReferralSummary }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }));

import { useUser } from '@client/app/contexts/UserContext';
import { ReferralRewardNotice, rewardNoticeMessage } from './ReferralRewardNotice';

const reward = (id: string, credits: number, expiresAt = '2027-02-01T12:00:00.000Z') => ({
  id,
  credits,
  grantedAt: '2026-11-03T00:00:00.000Z',
  expiresAt,
});
const summary = (recentRewards: ReturnType<typeof reward>[], enabled = true) => ({
  data: { enabled, invited: 1, active: 1, subscribed: 0, creditsEarned: 0, recentRewards },
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUser.setState({ currentUser: { id: 'u1', regInvites: ['inv1'] } } as never);
  useGetReferralSummary.mockReturnValue(summary([]));
});

describe('ReferralRewardNotice', () => {
  it('announces a usable reward with its amount and expiry', () => {
    useGetReferralSummary.mockReturnValue(summary([reward('tx1', 6000)]));
    render(<ReferralRewardNotice />);

    expect(toastSuccess).toHaveBeenCalledOnce();
    expect(toastSuccess.mock.calls[0][0]).toBe(
      'You earned 6,000 credits for a friend you invited. They are ready to use and expire on Feb 1, 2027.'
    );
  });

  it('announces each reward once, even across remounts', () => {
    useGetReferralSummary.mockReturnValue(summary([reward('tx1', 6000)]));
    const first = render(<ReferralRewardNotice />);
    first.unmount();
    render(<ReferralRewardNotice />);

    expect(toastSuccess).toHaveBeenCalledOnce();
  });

  it('announces only the rewards not seen yet', () => {
    window.localStorage.setItem('referral-rewards-seen:u1', JSON.stringify(['tx1']));
    useGetReferralSummary.mockReturnValue(summary([reward('tx1', 6000), reward('tx2', 1000)]));
    render(<ReferralRewardNotice />);

    expect(toastSuccess.mock.calls[0][0]).toContain('1,000 credits');
  });

  it('says nothing while the program is off or nothing is new', () => {
    useGetReferralSummary.mockReturnValue(summary([reward('tx1', 6000)], false));
    render(<ReferralRewardNotice />);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('does not ask the server for an account that never invited anyone', () => {
    useUser.setState({ currentUser: { id: 'u1', regInvites: [] } } as never);
    render(<ReferralRewardNotice />);
    expect(useGetReferralSummary).toHaveBeenCalledWith({ enabled: false });
  });

  it('still announces when browser storage is blocked', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    useGetReferralSummary.mockReturnValue(summary([reward('tx1', 6000)]));
    const { rerender } = render(<ReferralRewardNotice />);

    expect(toastSuccess).toHaveBeenCalledOnce();

    // A refetch hands back a new summary object; the same reward must not be announced again.
    useGetReferralSummary.mockReturnValue(summary([reward('tx1', 6000)]));
    rerender(<ReferralRewardNotice />);
    expect(toastSuccess).toHaveBeenCalledOnce();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('rewardNoticeMessage', () => {
  it('sums several rewards and names the soonest expiry', () => {
    expect(
      rewardNoticeMessage([
        reward('a', 6000, '2027-03-01T12:00:00.000Z'),
        reward('b', 1000, '2027-02-01T12:00:00.000Z'),
      ])
    ).toBe('You earned 7,000 credits for 2 friends you invited. They are ready to use and expire on Feb 1, 2027.');
  });
});
