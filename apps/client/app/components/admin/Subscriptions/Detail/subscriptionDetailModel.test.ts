import { describe, expect, it } from 'vitest';
import {
  NO_ACTING_USER_REASON,
  REMOVE_LIVE_STRIPE_REASON,
  addMonths,
  compExtensionBase,
  ownerDisplayName,
  ownerLink,
  possibleDuplicateIds,
  relativeFromNow,
  subscriptionActionAvailability,
} from './subscriptionDetailModel';
import { STRIPE_ROW, buildDetail, buildRow } from './subscriptionDetailTestUtils';

describe('subscriptionActionAvailability', () => {
  it('offers the comp actions, credits and remove on a live comp', () => {
    expect(subscriptionActionAvailability(buildDetail())).toEqual({
      compActions: true,
      stripeCancel: false,
      stripeResume: false,
      editCredits: { visible: true, disabledReason: null },
      remove: { disabledReason: null },
    });
  });

  it('blocks remove on a live Stripe row and offers no comp actions', () => {
    expect(subscriptionActionAvailability(buildDetail({ subscription: STRIPE_ROW }))).toEqual({
      compActions: false,
      stripeCancel: true,
      stripeResume: false,
      editCredits: { visible: true, disabledReason: null },
      remove: { disabledReason: REMOVE_LIVE_STRIPE_REASON },
    });
  });

  it('allows removing an ended Stripe row and hides credits on any ended row', () => {
    const endedStripe = subscriptionActionAvailability(
      buildDetail({ subscription: { ...STRIPE_ROW, status: 'canceled' } })
    );
    expect(endedStripe).toEqual({
      compActions: false,
      stripeCancel: false,
      stripeResume: false,
      editCredits: { visible: false, disabledReason: null },
      remove: { disabledReason: null },
    });
    expect(
      subscriptionActionAvailability(buildDetail({ subscription: { status: 'incomplete_expired' } })).compActions
    ).toBe(false);
  });

  it('offers resume instead of cancel only while a cancellation is scheduled and the period runs', () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const scheduled = { ...STRIPE_ROW, periodEndsAt: future, cancelAt: future };

    const live = subscriptionActionAvailability(buildDetail({ subscription: scheduled }));
    expect([live.stripeCancel, live.stripeResume]).toEqual([false, true]);

    const lapsed = subscriptionActionAvailability(
      buildDetail({ subscription: { ...scheduled, periodEndsAt: past, cancelAt: past } })
    );
    expect([lapsed.stripeCancel, lapsed.stripeResume]).toEqual([false, false]);

    const noPeriodEnd = subscriptionActionAvailability(
      buildDetail({ subscription: { ...scheduled, periodEndsAt: null } })
    );
    expect(noPeriodEnd.stripeResume).toBe(false);
  });

  it('offers no Stripe action on a legacy comp row that reads as source stripe', () => {
    const legacyComp = subscriptionActionAvailability(
      buildDetail({ subscription: { ...STRIPE_ROW, source: 'stripe', subscriptionId: 'admin_granted_1' } })
    );
    expect([legacyComp.stripeCancel, legacyComp.stripeResume]).toEqual([false, false]);
    expect(legacyComp.remove.disabledReason).not.toBe(REMOVE_LIVE_STRIPE_REASON);
  });

  it('reads a period-end schedule from the mirror flag when the row has no cancel date', () => {
    const detail = buildDetail({
      subscription: { ...STRIPE_ROW, periodEndsAt: null, cancelAt: null },
      stripe: { lastSyncedAt: null, cancelAtPeriodEnd: true, stateToken: 't' },
    });
    expect(subscriptionActionAvailability(detail).stripeCancel).toBe(false);
  });

  it('disables credits and remove when no account can act for the owner', () => {
    const available = subscriptionActionAvailability(buildDetail({ actingUserId: null }));
    expect(available.compActions).toBe(true);
    expect(available.editCredits.disabledReason).toBe(NO_ACTING_USER_REASON);
    expect(available.remove.disabledReason).toBe(NO_ACTING_USER_REASON);
  });
});

describe('owner helpers', () => {
  it('falls back from name to email to username, and names a deleted owner', () => {
    expect(ownerDisplayName(buildRow())).toBe('Ada Lovelace');
    expect(
      ownerDisplayName(
        buildRow({
          owner: { kind: 'User', id: 'u', name: null, email: 'a@b.c', username: 'abc', stripeCustomerId: null },
        })
      )
    ).toBe('a@b.c');
    expect(
      ownerDisplayName(
        buildRow({ owner: { kind: 'User', id: 'u', name: null, email: null, username: 'abc', stripeCustomerId: null } })
      )
    ).toBe('abc');
    expect(ownerDisplayName(buildRow({ owner: null }))).toBe('Deleted owner');
  });

  it('links a user to the profile and an organization to the console tab', () => {
    expect(ownerLink(buildRow())).toEqual({ kind: 'user', userId: buildRow().ownerId });
    const org = buildRow({
      ownerType: 'Organization',
      owner: {
        kind: 'Organization',
        id: 'org1',
        name: 'Acme',
        stripeCustomerId: null,
        seats: 5,
        memberCount: 3,
        billingOwnerId: null,
      },
    });
    expect(ownerLink(org)).toEqual({ kind: 'organization', organizationId: 'org1' });
    expect(ownerLink(buildRow({ owner: null }))).toBeNull();
  });
});

describe('dates', () => {
  it('adds calendar months and clamps to the last day of a short month', () => {
    expect(addMonths(new Date('2026-01-31T12:00:00Z'), 1).toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(addMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString()).toBe('2027-02-15T00:00:00.000Z');
  });

  it('extends a lapsed comp from now, a live one from its end', () => {
    const now = Date.parse('2026-10-29T00:00:00Z');
    expect(compExtensionBase(buildRow({ periodEndsAt: '2026-01-01T00:00:00Z' }), now).getTime()).toBe(now);
    expect(compExtensionBase(buildRow({ periodEndsAt: '2026-12-01T00:00:00Z' }), now).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z'
    );
  });

  it('reads both past and future relative times', () => {
    const now = Date.parse('2026-10-29T00:00:00Z');
    expect(relativeFromNow('2026-11-01T00:00:00Z', now)).toBe('in 3 days');
    expect(relativeFromNow('2026-10-27T00:00:00Z', now)).toBe('2 days ago');
  });
});

describe('possibleDuplicateIds', () => {
  it('marks live others when the owner holds more than one live subscription', () => {
    const detail = buildDetail({
      otherSubscriptions: [buildRow({ id: 'live-other' }), buildRow({ id: 'ended-other', status: 'canceled' })],
    });
    expect([...possibleDuplicateIds(detail)]).toEqual(['live-other']);
  });

  it('marks nothing when only one subscription is live', () => {
    const detail = buildDetail({
      subscription: { status: 'canceled' },
      otherSubscriptions: [buildRow({ id: 'live-other' })],
    });
    expect(possibleDuplicateIds(detail).size).toBe(0);
  });
});
