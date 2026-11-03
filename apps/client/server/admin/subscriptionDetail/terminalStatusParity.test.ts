import { describe, expect, it } from 'vitest';
import {
  SubscriptionSource,
  TERMINAL_SUBSCRIPTION_STATUSES,
  resolveSubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  LEGACY_COMP_SUBSCRIPTION_ID_PREFIX,
  TERMINAL_SUBSCRIPTION_STATUS_VALUES,
} from '@client/app/utils/adminSubscriptionDetail';

// The client bundle cannot import server-utils, so these client copies are pinned to the server originals here.
describe('admin subscription detail client/server parity', () => {
  it('TERMINAL_SUBSCRIPTION_STATUS_VALUES matches TERMINAL_SUBSCRIPTION_STATUSES', () => {
    expect(new Set(TERMINAL_SUBSCRIPTION_STATUS_VALUES)).toEqual(new Set(TERMINAL_SUBSCRIPTION_STATUSES));
  });

  it('LEGACY_COMP_SUBSCRIPTION_ID_PREFIX is the prefix resolveSubscriptionSource treats as a comp', () => {
    expect(resolveSubscriptionSource({ subscriptionId: `${LEGACY_COMP_SUBSCRIPTION_ID_PREFIX}x` })).toBe(
      SubscriptionSource.AdminGrant
    );
  });
});
