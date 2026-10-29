import { describe, it, expect } from 'vitest';
import { detectSubscriptionChanges } from './subscriptionChanges';

type Before = Parameters<typeof detectSubscriptionChanges>[0];
type After = Parameters<typeof detectSubscriptionChanges>[1];

const before = (over: Partial<Before> = {}): Before => ({
  priceId: 'price_basic',
  status: 'active',
  canceledAt: null,
  ...over,
});

const after = (over: { status?: string; canceled_at?: number | null; priceId?: string } = {}): After =>
  ({
    status: over.status ?? 'active',
    canceled_at: over.canceled_at ?? null,
    items: { data: [{ price: { id: over.priceId ?? 'price_basic' } }] },
  }) as unknown as After;

describe('detectSubscriptionChanges', () => {
  it('reports nothing when nothing changed', () => {
    expect(detectSubscriptionChanges(before(), after())).toEqual({ plan: null, cancel: null, ended: false });
  });

  it('reports a move to another price', () => {
    expect(detectSubscriptionChanges(before(), after({ priceId: 'price_pro' }))).toEqual({
      plan: { fromPriceId: 'price_basic', toPriceId: 'price_pro' },
      cancel: null,
      ended: false,
    });
  });

  it('reports no plan change for a row without a price', () => {
    expect(detectSubscriptionChanges(before({ priceId: undefined }), after({ priceId: 'price_pro' })).plan).toBeNull();
  });

  it('reports a cancel being scheduled and withdrawn', () => {
    expect(detectSubscriptionChanges(before(), after({ canceled_at: 1_790_000_000 })).cancel).toBe('scheduled');
    expect(detectSubscriptionChanges(before({ canceledAt: new Date() }), after()).cancel).toBe('reverted');
  });

  it('reports a pending cancel only once', () => {
    expect(
      detectSubscriptionChanges(before({ canceledAt: new Date() }), after({ canceled_at: 1_790_000_000 })).cancel
    ).toBeNull();
  });

  it('reports the move into canceled as an end, from a pending cancel or straight from active', () => {
    const canceled = after({ status: 'canceled', canceled_at: 1_790_000_000 });
    expect(detectSubscriptionChanges(before(), canceled).ended).toBe(true);
    expect(detectSubscriptionChanges(before({ canceledAt: new Date() }), canceled).ended).toBe(true);
    expect(detectSubscriptionChanges(before({ status: 'past_due' }), canceled).ended).toBe(true);
  });

  it('reports an end only once', () => {
    const canceled = after({ status: 'canceled', canceled_at: 1_790_000_000 });
    expect(detectSubscriptionChanges(before({ status: 'canceled', canceledAt: new Date() }), canceled).ended).toBe(
      false
    );
  });

  it('reports no cancel change for a subscription that has ended', () => {
    expect(
      detectSubscriptionChanges(before(), after({ status: 'canceled', canceled_at: 1_790_000_000 })).cancel
    ).toBeNull();
    expect(
      detectSubscriptionChanges(
        before({ canceledAt: new Date() }),
        after({ status: 'canceled', canceled_at: 1_790_000_000 })
      ).cancel
    ).toBeNull();
  });

  it('reports both when one update changes the price and schedules a cancel', () => {
    expect(detectSubscriptionChanges(before(), after({ priceId: 'price_pro', canceled_at: 1_790_000_000 }))).toEqual({
      plan: { fromPriceId: 'price_basic', toPriceId: 'price_pro' },
      cancel: 'scheduled',
      ended: false,
    });
  });
});
