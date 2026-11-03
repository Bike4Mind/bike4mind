import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionsFilter';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

import { useOpenSubscriptionOwner, useOpenSubscriptionRow } from './useOpenSubscriptionRow';

const row = (owner: AdminSubscriptionRow['owner']): AdminSubscriptionRow => ({
  id: 's1',
  subscriptionId: 'sub_1',
  ownerType: owner?.kind ?? 'User',
  ownerId: owner?.id ?? 'deleted',
  owner,
  plan: { priceId: null, name: null, interval: null },
  billedInterval: null,
  status: 'active',
  source: 'stripe',
  quantity: 1,
  customCreditsPerCycle: null,
  mrr: null,
  periodStartsAt: '2026-10-01T00:00:00.000Z',
  periodEndsAt: '2026-11-01T00:00:00.000Z',
  canceledAt: null,
  cancelAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
});

const USER_OWNER: AdminSubscriptionRow['owner'] = {
  kind: 'User',
  id: 'user1',
  name: null,
  username: null,
  email: null,
  stripeCustomerId: null,
};

beforeEach(() => {
  navigate.mockReset();
});

describe('subscription row navigation', () => {
  it('opens the subscription detail page by its record id', () => {
    const { result } = renderHook(() => useOpenSubscriptionRow());
    act(() => result.current(row(USER_OWNER)));
    expect(navigate).toHaveBeenCalledWith({
      to: '/admin/subscriptions/$subscriptionId',
      params: { subscriptionId: 's1' },
    });
  });

  it('opens the detail page for a deleted customer too', () => {
    const { result } = renderHook(() => useOpenSubscriptionRow());
    act(() => result.current(row(null)));
    expect(navigate).toHaveBeenCalledWith({
      to: '/admin/subscriptions/$subscriptionId',
      params: { subscriptionId: 's1' },
    });
  });
});

describe('subscription customer navigation', () => {
  it('opens an individual customer profile', () => {
    const { result } = renderHook(() => useOpenSubscriptionOwner());
    act(() => result.current(row(USER_OWNER)));
    expect(navigate).toHaveBeenCalledWith({ to: '/admin/users/$userId', params: { userId: 'user1' } });
  });

  it('opens the organization while removing subscription view params', () => {
    const { result } = renderHook(() => useOpenSubscriptionOwner());
    act(() =>
      result.current(
        row({
          kind: 'Organization',
          id: 'org1',
          name: null,
          stripeCustomerId: null,
          seats: 2,
          memberCount: 2,
          billingOwnerId: 'user1',
        })
      )
    );
    const destination = navigate.mock.calls[0]?.[0] as {
      to: string;
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(destination.to).toBe('/admin');
    expect(destination.search({ tab: 'subscriptions', subsSource: 'stripe', emergency_access: 'true' })).toMatchObject({
      tab: 'organizations',
      orgId: 'org1',
      subsSource: undefined,
      emergency_access: 'true',
    });
  });

  it('does not navigate for a deleted customer', () => {
    const { result } = renderHook(() => useOpenSubscriptionOwner());
    act(() => result.current(row(null)));
    expect(navigate).not.toHaveBeenCalled();
  });
});
