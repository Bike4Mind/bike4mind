import { describe, it, expect, beforeEach } from 'vitest';
import {
  BILLING_CHECKOUT_RETURN_TTL_MS,
  consumeBillingCheckoutReturn,
  markBillingCheckoutReturn,
} from './billingCheckoutReturn';

describe('billingCheckoutReturn', () => {
  beforeEach(() => {
    consumeBillingCheckoutReturn();
  });

  it('is consumed once', () => {
    markBillingCheckoutReturn(1_000);
    expect(consumeBillingCheckoutReturn(2_000)).toBe(true);
    expect(consumeBillingCheckoutReturn(2_000)).toBe(false);
  });

  it('is false when nothing was marked', () => {
    expect(consumeBillingCheckoutReturn()).toBe(false);
  });

  it('expires when no modal consumed it in time, so a later genuine open is not swallowed', () => {
    markBillingCheckoutReturn(1_000);
    expect(consumeBillingCheckoutReturn(1_000 + BILLING_CHECKOUT_RETURN_TTL_MS)).toBe(false);
  });
});
