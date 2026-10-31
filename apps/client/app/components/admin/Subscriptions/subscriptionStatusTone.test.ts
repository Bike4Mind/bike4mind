import { describe, expect, it } from 'vitest';
import { isCancelScheduled, isCompedRow, subscriptionStatusDisplay } from './subscriptionStatusTone';

describe('subscriptionStatusDisplay', () => {
  it('maps a plain status to its label and tone', () => {
    expect(subscriptionStatusDisplay({ status: 'past_due' })).toEqual({ label: 'Past due', tone: 'warn' });
    expect(subscriptionStatusDisplay({ status: '' })).toEqual({ label: 'Unknown', tone: 'neutral' });
  });

  it.each([
    ['cancelAt', { cancelAt: '2026-11-15T00:00:00.000Z' }],
    ['cancelAtPeriodEnd', { cancelAtPeriodEnd: true }],
    ['canceledAt on a live row', { canceledAt: '2026-10-01T00:00:00.000Z' }],
  ])('reads a live row with %s as Canceling', (_field, cancel) => {
    expect(subscriptionStatusDisplay({ status: 'active', ...cancel })).toEqual({ label: 'Canceling', tone: 'warn' });
    expect(subscriptionStatusDisplay({ status: 'trialing', ...cancel }).label).toBe('Canceling');
  });

  it('keeps an ended row Canceled whatever its cancel fields say', () => {
    const row = { status: 'canceled', canceledAt: '2026-10-01T00:00:00.000Z', cancelAtPeriodEnd: true };
    expect(isCancelScheduled(row)).toBe(false);
    expect(subscriptionStatusDisplay(row).label).toBe('Canceled');
  });
});

describe('isCompedRow', () => {
  it('counts every admin grant, ended ones and legacy ids too', () => {
    expect(isCompedRow({ source: 'admin_grant', subscriptionId: 'admin_grant_1' })).toBe(true);
    expect(isCompedRow({ source: 'stripe', subscriptionId: 'admin_granted_1' })).toBe(true);
    expect(isCompedRow({ source: 'stripe', subscriptionId: 'sub_1' })).toBe(false);
  });
});
