import { describe, expect, it } from 'vitest';
import { parseAdminSearch } from '../adminTabParams';
import {
  REVENUE_SEARCH_PARSERS,
  hasPaymentsFilters,
  paymentsApiFilter,
  paymentsParamsError,
  paymentsParamsFromSearch,
  paymentsParamsToSearch,
  revenueViewFromSearch,
} from './revenueTabSearch';

const NOW = new Date('2026-11-11T12:00:00Z');

describe('revenueTabSearch', () => {
  it('reads the view, defaulting to Subscriptions', () => {
    expect(revenueViewFromSearch({})).toBe('subscriptions');
    expect(revenueViewFromSearch({ revenueView: 'payments' })).toBe('payments');
    expect(revenueViewFromSearch({ revenueView: 'bogus' })).toBe('subscriptions');
  });

  it('falls back to the last 30 UTC days and the first page of 25', () => {
    expect(paymentsParamsFromSearch({}, NOW)).toEqual({
      from: '2026-10-13',
      to: '2026-11-11',
      kind: undefined,
      status: undefined,
      ownerType: undefined,
      currency: undefined,
      minAmount: undefined,
      maxAmount: undefined,
      page: 1,
      limit: 25,
    });
  });

  it('keeps valid params and drops invalid ones', () => {
    const params = paymentsParamsFromSearch(
      {
        payFrom: '2026-01-01',
        payTo: '2026-13-45',
        payKind: 'credit_purchase',
        payStatus: 'nope',
        payOwner: 'organization',
        payCurrency: 'EUR',
        payMin: '12.5',
        payMax: -3,
        payPage: '3',
        payLimit: 30,
      },
      NOW
    );
    expect(params).toMatchObject({
      from: '2026-01-01',
      to: '2026-11-11',
      kind: 'credit_purchase',
      status: undefined,
      ownerType: 'organization',
      currency: 'eur',
      minAmount: 12.5,
      maxAmount: undefined,
      page: 3,
      limit: 25,
    });
  });

  it('parses the params through the admin route registry', () => {
    const search = parseAdminSearch({ tab: 'revenue', revenueView: 'payments', payStatus: 'dispute_lost', payPage: 0 });
    expect(search.revenueView).toBe('payments');
    expect(search.payStatus).toBe('dispute_lost');
    expect(search.payPage).toBeUndefined();
    expect(REVENUE_SEARCH_PARSERS.payLimit('100')).toBe(100);
  });

  it('writes only the patched keys and leaves defaults out of the URL', () => {
    expect(paymentsParamsToSearch({ page: 1, limit: 25 })).toEqual({ payPage: undefined, payLimit: undefined });
    expect(paymentsParamsToSearch({ kind: 'subscription', page: 2 })).toEqual({ payKind: 'subscription', payPage: 2 });
    expect(paymentsParamsToSearch({ minAmount: undefined })).toEqual({ payMin: undefined });
  });

  it('sends amounts in minor units and leaves an empty search out', () => {
    const params = { ...paymentsParamsFromSearch({}, NOW), minAmount: 12.345, maxAmount: 100 };
    expect(paymentsApiFilter(params, '  ')).toMatchObject({ minAmount: 1235, maxAmount: 10_000, search: undefined });
    expect(paymentsApiFilter(params, ' ada@example.com ').search).toBe('ada@example.com');
  });

  it('explains filters the API would reject', () => {
    const base = paymentsParamsFromSearch({}, NOW);
    expect(paymentsParamsError(base)).toBeNull();
    expect(paymentsParamsError({ ...base, from: '2026-12-01' })).toMatch(/From date/);
    expect(paymentsParamsError({ ...base, from: '2020-01-01' })).toMatch(/at most 731 days/);
    expect(paymentsParamsError({ ...base, minAmount: 10, maxAmount: 5 })).toMatch(/minimum amount/);
  });

  it('counts the search and narrowing filters, not the range, as filters', () => {
    const base = paymentsParamsFromSearch({ payFrom: '2026-01-01' }, NOW);
    expect(hasPaymentsFilters(base, '')).toBe(false);
    expect(hasPaymentsFilters(base, 'ada')).toBe(true);
    expect(hasPaymentsFilters({ ...base, ownerType: 'user' }, '')).toBe(true);
  });
});
