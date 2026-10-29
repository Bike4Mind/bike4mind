import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Stripe from 'stripe';
import { SubscriptionOwnerType, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';

const mocks = vi.hoisted(() => ({
  config: { STAGE: 'production' as string | undefined },
  postMessageToSlack: vi.fn(),
  findByStripeSubscriptionId: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: mocks.config }));
vi.mock('./slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findByStripeSubscriptionId: mocks.findByStripeSubscriptionId },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// The plan catalogue has its own tests (billingEventDetails.test.ts); fixed names keep these readable.
vi.mock('@server/analytics/billingEventDetails', () => ({
  planDetails: (priceId: string | null | undefined) =>
    ({
      price_basic: { plan: 'Basic', interval: 'monthly' },
      price_pro: { plan: 'Pro', interval: 'monthly' },
      price_team: { plan: 'Team', interval: 'monthly' },
    })[priceId ?? ''] ?? { plan: 'unknown' },
  planChangeDirection: (from: string, to: string) =>
    from === 'price_basic' && to === 'price_pro' ? 'upgrade' : from === 'price_pro' ? 'downgrade' : 'unknown',
}));

import {
  adminOwnerSlackRef,
  buildSubscriptionLifecycleMessage,
  endedLifecycleEvent,
  paymentFailedLifecycleEvent,
  postNewPaidSubscriptionToSlack,
  postSubscriptionChangesToSlack,
  postSubscriptionLifecycleToSlack,
  subscriptionChangeLifecycleEvents,
  subscriptionEndReason,
  type SubscriptionLifecycleEvent,
} from './subscriptionLifecycle';

const APP_URL = 'https://app.example.com';
const USER_ID = '650000000000000000000001';
const ORG_ID = '650000000000000000000002';
const user = { ownerType: SubscriptionOwnerType.User, ownerId: USER_ID };
const org = { ownerType: SubscriptionOwnerType.Organization, ownerId: ORG_ID };
const pro = { plan: 'Pro', interval: 'monthly' };
const userLink = `<${APP_URL}/admin/users/${USER_ID}|Open in admin>`;

const row = (over: Partial<ISubscription> = {}): ISubscription =>
  ({
    ownerType: SubscriptionOwnerType.User,
    ownerId: USER_ID,
    subscriptionId: 'sub_1',
    priceId: 'price_basic',
    status: 'active',
    canceledAt: null,
    ...over,
  }) as ISubscription;

type ChangeInput = Parameters<typeof subscriptionChangeLifecycleEvents>[1];
const stripeSub = (over: Partial<ChangeInput> = {}, priceId = 'price_basic', quantity = 1): ChangeInput =>
  ({
    status: 'active',
    canceled_at: null,
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          quantity,
          current_period_end: 1_798_761_600, // 2027-01-01
          price: { id: priceId, unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } },
        },
      ],
    },
    ...over,
  }) as unknown as ChangeInput;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.STAGE = 'production';
  mocks.postMessageToSlack.mockResolvedValue(true);
  vi.stubEnv('APP_URL', APP_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildSubscriptionLifecycleMessage', () => {
  it('renders each event kind', () => {
    const messages: Array<[SubscriptionLifecycleEvent, string]> = [
      [
        {
          kind: 'new_paid',
          owner: user,
          plan: pro,
          price: { amountMinor: 2000, currency: 'usd', interval: 'month' },
          firstCharge: { amountMinor: 1000, currency: 'usd' },
          quantity: 1,
        },
        `:tada: *New paid subscription*\n*Plan:* Pro (monthly)\n*Amount:* $20.00/mo\n*First charge:* $10.00\n*User:* \`${USER_ID}\` - ${userLink}`,
      ],
      [
        {
          kind: 'plan_changed',
          owner: user,
          direction: 'upgrade',
          from: { plan: 'Basic', interval: 'monthly' },
          to: { plan: 'Pro', interval: 'yearly' },
          price: { amountMinor: 20000, currency: 'usd', interval: 'year' },
          quantity: 1,
        },
        `:arrow_up: *Plan upgraded*\n*Plan:* Basic (monthly) -> Pro (yearly)\n*Amount:* $200.00/yr\n*User:* \`${USER_ID}\` - ${userLink}`,
      ],
      [
        { kind: 'cancel_scheduled', owner: user, plan: pro, endsAt: new Date('2026-11-28T12:00:00Z') },
        `:hourglass_flowing_sand: *Cancellation scheduled*\n*Plan:* Pro (monthly)\n*Ends:* 2026-11-28\n*User:* \`${USER_ID}\` - ${userLink}`,
      ],
      [
        { kind: 'cancel_reverted', owner: user, plan: pro },
        `:recycle: *Cancellation reverted*\n*Plan:* Pro (monthly)\n*User:* \`${USER_ID}\` - ${userLink}`,
      ],
      [
        { kind: 'ended', owner: user, plan: pro, reason: 'payment_failed' },
        `:wave: *Subscription ended*\n*Plan:* Pro (monthly)\n*Reason:* payment failed\n*User:* \`${USER_ID}\` - ${userLink}`,
      ],
      [
        { kind: 'payment_failed', owner: user, plan: pro, amountDue: { amountMinor: 2000, currency: 'usd' } },
        `:warning: *Subscription payment failed*\n*Plan:* Pro (monthly)\n*Amount due:* $20.00\n*User:* \`${USER_ID}\` - ${userLink}`,
      ],
    ];

    for (const [event, expected] of messages) {
      expect(buildSubscriptionLifecycleMessage(event, APP_URL)).toBe(expected);
    }
  });

  it('formats money in the currency, with its own minor unit', () => {
    const amount = (amountMinor: number, currency: string, interval?: 'month' | 'year') =>
      buildSubscriptionLifecycleMessage(
        {
          kind: 'new_paid',
          owner: user,
          plan: pro,
          price: { amountMinor, currency, interval },
          firstCharge: null,
          quantity: 1,
        },
        null
      ).split('\n')[2];

    expect(amount(1999, 'usd', 'month')).toBe('*Amount:* $19.99/mo');
    expect(amount(1500, 'eur', 'year')).toBe('*Amount:* \u20AC15.00/yr');
    expect(amount(3000, 'jpy', 'month')).toBe('*Amount:* \u00A53,000/mo');
    expect(amount(12345, 'kwd')).toBe('*Amount:* KWD\u00A012.345');
    expect(amount(500, 'zz')).toBe('*Amount:* 5 ZZ');
  });

  it('posts the bare ID when APP_URL is unset', () => {
    const message = buildSubscriptionLifecycleMessage({ kind: 'cancel_reverted', owner: user, plan: pro }, null);

    expect(message).toContain(`*User:* \`${USER_ID}\``);
    expect(message).not.toContain('Open in admin');
    expect(message).not.toContain('<');
  });

  it("links an organization to the admin console's organization view and shows its seats", () => {
    const message = buildSubscriptionLifecycleMessage(
      {
        kind: 'new_paid',
        owner: org,
        plan: { plan: 'Team', interval: 'monthly' },
        price: { amountMinor: 10000, currency: 'usd', interval: 'month' },
        firstCharge: null,
        quantity: 5,
      },
      `${APP_URL}/`
    );

    expect(message).toContain('*Seats:* 5');
    expect(message).toContain(
      `*Organization:* \`${ORG_ID}\` - <${APP_URL}/admin?tab=organizations&amp;orgId=${ORG_ID}|Open in admin>`
    );
  });

  it('encodes an owner ID so it cannot break out of the link', () => {
    expect(adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: 'a|b>c' }, APP_URL)).toBe(
      `\`a|b&gt;c\` - <${APP_URL}/admin/users/a%7Cb%3Ec|Open in admin>`
    );
  });
});

describe('no customer PII reaches a message', () => {
  // A row and Stripe objects carrying every identity field they could; only IDs may come out.
  const pii = { email: 'jane.doe@example.com', name: 'Jane Doe', username: 'janed', organizationName: 'Acme Corp' };
  const leaky = (over: Partial<ISubscription> = {}) => ({ ...row(over), ...pii }) as ISubscription;
  const assertNoPii = (message: string) => {
    expect(message).not.toContain('@');
    for (const value of Object.values(pii)) expect(message).not.toContain(value);
  };

  it('holds for every event kind, user- and organization-owned', async () => {
    for (const owner of [user, org]) {
      const before = leaky({ ...owner, canceledAt: null });
      const sub = { ...stripeSub({ canceled_at: 1_790_000_000, cancel_at_period_end: true }, 'price_pro', 3), ...pii };
      const events = [
        endedLifecycleEvent(leaky(owner), 'cancellation_requested'),
        paymentFailedLifecycleEvent(leaky(owner), { amount_due: 2000, currency: 'usd' }),
        ...subscriptionChangeLifecycleEvents(before, sub),
        ...subscriptionChangeLifecycleEvents(leaky({ ...owner, canceledAt: new Date() }), stripeSub()),
      ];
      expect(new Set(events.map(e => e.kind))).toEqual(
        new Set(['ended', 'payment_failed', 'plan_changed', 'cancel_scheduled', 'cancel_reverted'])
      );
      for (const event of events) {
        assertNoPii(buildSubscriptionLifecycleMessage(event, APP_URL));
        assertNoPii(buildSubscriptionLifecycleMessage(event, null));
      }

      mocks.findByStripeSubscriptionId.mockResolvedValue(leaky(owner));
      await postNewPaidSubscriptionToSlack(
        { amount_paid: 2000, currency: 'usd', customer_email: pii.email, customer_name: pii.name } as Stripe.Invoice,
        { id: 'sub_1', items: stripeSub().items }
      );
    }

    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(2);
    for (const [message] of mocks.postMessageToSlack.mock.calls) assertNoPii(message);
  });
});

describe('postSubscriptionLifecycleToSlack', () => {
  const event: SubscriptionLifecycleEvent = { kind: 'cancel_reverted', owner: user, plan: pro };

  it('posts to the subscriptions webhook in production', async () => {
    await postSubscriptionLifecycleToSlack(event);

    expect(mocks.postMessageToSlack).toHaveBeenCalledWith(
      expect.stringContaining(':recycle: *Cancellation reverted*'),
      'SlackSubscriptionsWebhookUrl'
    );
  });

  it.each(['staging', 'pr123', 'dev-someone', undefined])('posts nothing from stage %s', async stage => {
    mocks.config.STAGE = stage;

    await postSubscriptionLifecycleToSlack(event);
    await postNewPaidSubscriptionToSlack(
      { amount_paid: 2000, currency: 'usd' },
      { id: 'sub_1', items: stripeSub().items }
    );
    await postSubscriptionChangesToSlack(row(), stripeSub({}, 'price_pro'));

    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
    expect(mocks.findByStripeSubscriptionId).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mocks.postMessageToSlack.mockRejectedValue(new Error('slack down'));

    await expect(postSubscriptionLifecycleToSlack(event)).resolves.toBeUndefined();
  });
});

describe('postNewPaidSubscriptionToSlack', () => {
  const invoice = { amount_paid: 1000, currency: 'usd' };

  it('announces the recurring price of a subscription the invoice handler recorded', async () => {
    mocks.findByStripeSubscriptionId.mockResolvedValue(row({ priceId: 'price_pro' }));

    await postNewPaidSubscriptionToSlack(
      { amount_paid: 2000, currency: 'usd' },
      { id: 'sub_1', items: stripeSub({}, 'price_pro').items }
    );

    expect(mocks.findByStripeSubscriptionId).toHaveBeenCalledWith('sub_1');
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toBe(
      `:tada: *New paid subscription*\n*Plan:* Pro (monthly)\n*Amount:* $20.00/mo\n*User:* \`${USER_ID}\` - ${userLink}`
    );
  });

  it('adds the first charge when a coupon, proration or tax made it differ from the price', async () => {
    mocks.findByStripeSubscriptionId.mockResolvedValue(row({ priceId: 'price_pro' }));

    await postNewPaidSubscriptionToSlack(invoice, { id: 'sub_1', items: stripeSub({}, 'price_pro').items });

    expect(mocks.postMessageToSlack.mock.calls[0][0]).toBe(
      `:tada: *New paid subscription*\n*Plan:* Pro (monthly)\n*Amount:* $20.00/mo\n*First charge:* $10.00\n*User:* \`${USER_ID}\` - ${userLink}`
    );
  });

  it('multiplies the seat price for an organization', async () => {
    mocks.findByStripeSubscriptionId.mockResolvedValue(row({ ...org, priceId: 'price_team' }));

    await postNewPaidSubscriptionToSlack(invoice, { id: 'sub_1', items: stripeSub({}, 'price_team', 4).items });

    const message = mocks.postMessageToSlack.mock.calls[0][0];
    expect(message).toContain('*Amount:* $80.00/mo');
    expect(message).toContain('*Seats:* 4');
  });

  it('falls back to the amount paid for a price with no unit amount', async () => {
    mocks.findByStripeSubscriptionId.mockResolvedValue(row());
    const items = stripeSub().items;
    items.data[0].price.unit_amount = null;

    await postNewPaidSubscriptionToSlack(invoice, { id: 'sub_1', items });

    const message = mocks.postMessageToSlack.mock.calls[0][0];
    expect(message).toContain('*Amount:* $10.00/mo');
    expect(message).not.toContain('First charge');
  });

  it('posts nothing when the handler recorded no subscription', async () => {
    mocks.findByStripeSubscriptionId.mockResolvedValue(null);

    await postNewPaidSubscriptionToSlack(invoice, { id: 'sub_1', items: stripeSub().items });

    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mocks.findByStripeSubscriptionId.mockRejectedValue(new Error('db down'));

    await expect(
      postNewPaidSubscriptionToSlack(invoice, { id: 'sub_1', items: stripeSub().items })
    ).resolves.toBeUndefined();
  });
});

describe('subscriptionChangeLifecycleEvents', () => {
  it('reports a move to another price with its direction and the new price', () => {
    expect(subscriptionChangeLifecycleEvents(row(), stripeSub({}, 'price_pro'))).toEqual([
      {
        kind: 'plan_changed',
        owner: user,
        direction: 'upgrade',
        from: { plan: 'Basic', interval: 'monthly' },
        to: pro,
        price: { amountMinor: 2000, currency: 'usd', interval: 'month' },
        quantity: 1,
      },
    ]);
  });

  it('reports a cancel being scheduled, ending when Stripe will cancel', () => {
    const events = subscriptionChangeLifecycleEvents(
      row(),
      stripeSub({ canceled_at: 1_790_000_000, cancel_at: 1_798_761_600, cancel_at_period_end: true })
    );

    expect(events).toEqual([
      {
        kind: 'cancel_scheduled',
        owner: user,
        plan: { plan: 'Basic', interval: 'monthly' },
        endsAt: new Date('2027-01-01T00:00:00Z'),
      },
    ]);
  });

  it('falls back to the period end when Stripe gives no cancel_at', () => {
    const [event] = subscriptionChangeLifecycleEvents(
      row(),
      stripeSub({ canceled_at: 1_790_000_000, cancel_at_period_end: true })
    );

    expect(event).toMatchObject({ kind: 'cancel_scheduled', endsAt: new Date('2027-01-01T00:00:00Z') });
  });

  it('reports a scheduled cancel being withdrawn', () => {
    expect(subscriptionChangeLifecycleEvents(row({ canceledAt: new Date() }), stripeSub())).toEqual([
      { kind: 'cancel_reverted', owner: user, plan: { plan: 'Basic', interval: 'monthly' } },
    ]);
  });

  it("reports a sync into canceled as the end, with Stripe's reason", () => {
    const canceled = stripeSub({
      status: 'canceled',
      canceled_at: 1_790_000_000,
      cancellation_details: { reason: 'cancellation_requested', comment: null, feedback: null },
    });

    expect(subscriptionChangeLifecycleEvents(row({ canceledAt: new Date() }), canceled)).toEqual([
      { kind: 'ended', owner: user, plan: { plan: 'Basic', interval: 'monthly' }, reason: 'cancellation_requested' },
    ]);
  });

  it('reports nothing for an update that repeats the state it found, an end included', () => {
    expect(subscriptionChangeLifecycleEvents(row(), stripeSub())).toEqual([]);
    expect(
      subscriptionChangeLifecycleEvents(
        row({ canceledAt: new Date() }),
        stripeSub({ canceled_at: 1_790_000_000, cancel_at_period_end: true })
      )
    ).toEqual([]);
    expect(
      subscriptionChangeLifecycleEvents(
        row({ status: 'canceled', canceledAt: new Date() }),
        stripeSub({ status: 'canceled', canceled_at: 1_790_000_000 })
      )
    ).toEqual([]);
  });

  it('posts each change it finds', async () => {
    await postSubscriptionChangesToSlack(
      row(),
      stripeSub({ canceled_at: 1_790_000_000, cancel_at_period_end: true }, 'price_pro')
    );

    expect(mocks.postMessageToSlack.mock.calls.map(([message]) => message.split('\n')[0])).toEqual([
      ':arrow_up: *Plan upgraded*',
      ':hourglass_flowing_sand: *Cancellation scheduled*',
    ]);
  });

  it('posts the end once when the sync reaches canceled and a later update finds it there', async () => {
    const canceled = stripeSub({
      status: 'canceled',
      canceled_at: 1_790_000_000,
      cancellation_details: { reason: 'payment_failed', comment: null, feedback: null },
    });

    await postSubscriptionChangesToSlack(row({ status: 'past_due' }), canceled);
    await postSubscriptionChangesToSlack(row({ status: 'canceled', canceledAt: new Date() }), canceled);

    expect(mocks.postMessageToSlack).toHaveBeenCalledOnce();
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toBe(
      `:wave: *Subscription ended*\n*Plan:* Basic (monthly)\n*Reason:* payment failed\n*User:* \`${USER_ID}\` - ${userLink}`
    );
  });
});

describe('subscriptionEndReason', () => {
  it("keeps Stripe's known reasons and reads anything else as unknown", () => {
    expect(subscriptionEndReason('payment_disputed')).toBe('payment_disputed');
    expect(subscriptionEndReason('something_new')).toBe('unknown');
    expect(subscriptionEndReason(null)).toBe('unknown');
    expect(subscriptionEndReason('toString')).toBe('unknown');
  });
});
