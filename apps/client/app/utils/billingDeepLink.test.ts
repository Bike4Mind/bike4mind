// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { billingLandingHref, parseBillingView, withBillingView } from './billingDeepLink';

describe('parseBillingView', () => {
  it.each(['credits', 'plans'])('accepts %s', view => {
    expect(parseBillingView(view)).toBe(view);
  });

  it.each(['', 'Credits', 'subscriptions', 1, undefined, null])('rejects %s', value => {
    expect(parseBillingView(value)).toBeUndefined();
  });
});

describe('withBillingView', () => {
  it('adds the param to an empty search', () => {
    expect(withBillingView('', 'plans')).toBe('?billing=plans');
  });

  it('keeps other params when setting and replacing the view', () => {
    expect(withBillingView('?projectId=p1&billing=credits', 'plans')).toBe('?projectId=p1&billing=plans');
  });

  it('removes only the billing param when closing', () => {
    expect(withBillingView('?projectId=p1&billing=credits', undefined)).toBe('?projectId=p1');
  });

  it('returns an empty string when nothing is left', () => {
    expect(withBillingView('?billing=credits', undefined)).toBe('');
  });
});

describe('billingLandingHref', () => {
  it('lands a valid view on /new with the modal param', () => {
    expect(billingLandingHref('credits')).toBe('/new?billing=credits');
  });

  it('lands an unknown view on a plain /new', () => {
    expect(billingLandingHref(undefined)).toBe('/new');
  });
});
