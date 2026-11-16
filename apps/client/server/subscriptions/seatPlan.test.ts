import { beforeEach, describe, expect, it, vi } from 'vitest';

const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findById } }));

import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import type { ActiveSubscription } from '@bike4mind/server-utils/entitlements/activeSubscriptions';
import { TEAM_PLAN } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { resolveSeatPlan } from './seatPlan';

const row = (ownerType: SubscriptionOwnerType, ownerId: string, priceId: string) =>
  ({ ownerType, ownerId, priceId, status: 'active' }) as unknown as ActiveSubscription;

describe('resolveSeatPlan', () => {
  beforeEach(() => {
    findById.mockReset();
    findById.mockImplementation(async (id: string) => (id === 'org-gone' ? null : { id, name: `Org ${id}` }));
  });

  it('returns null with no subscriptions', async () => {
    await expect(resolveSeatPlan([])).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('ignores the user own rows, so a personal plan is never reported as a seat', async () => {
    await expect(resolveSeatPlan([row(SubscriptionOwnerType.User, 'user-1', TEAM_PLAN.priceId)])).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('names the org and plan behind a Team seat', async () => {
    const active = [
      row(SubscriptionOwnerType.User, 'user-1', 'price_unknown'),
      row(SubscriptionOwnerType.Organization, 'org-1', TEAM_PLAN.priceId),
    ];

    await expect(resolveSeatPlan(active)).resolves.toEqual({
      organizationId: 'org-1',
      organizationName: 'Org org-1',
      planName: TEAM_PLAN.name,
    });
  });

  it('skips an org row whose price confers no plan', async () => {
    await expect(
      resolveSeatPlan([row(SubscriptionOwnerType.Organization, 'org-1', 'price_unknown')])
    ).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('falls through to the next org when one is gone', async () => {
    const active = [
      row(SubscriptionOwnerType.Organization, 'org-gone', TEAM_PLAN.priceId),
      row(SubscriptionOwnerType.Organization, 'org-2', TEAM_PLAN.priceId),
    ];

    await expect(resolveSeatPlan(active)).resolves.toMatchObject({ organizationId: 'org-2' });
  });
});
