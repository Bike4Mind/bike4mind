import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('@client/app/utils/purchaseConversion', () => ({ trackPurchaseConversion: vi.fn() }));

import { consumeBillingCheckoutReturn } from '@client/app/utils/billingCheckoutReturn';
import StripeCheckoutSuccessHandler from './StripeCheckoutSuccessHandler';

function returnTo(search: string) {
  window.history.replaceState({}, '', `/${search}`);
  return render(<StripeCheckoutSuccessHandler />);
}

describe('StripeCheckoutSuccessHandler', () => {
  beforeEach(() => {
    consumeBillingCheckoutReturn();
  });

  it('marks the return when it lands on an open Billing modal', () => {
    returnTo('?billing=plans&subscription_success=true');

    expect(consumeBillingCheckoutReturn()).toBe(true);
  });

  it('does not mark an ordinary subscription return', () => {
    returnTo('?subscription_success=true');

    expect(consumeBillingCheckoutReturn()).toBe(false);
  });

  it('does not mark a billing URL that is not a Stripe return', () => {
    returnTo('?billing=plans');

    expect(consumeBillingCheckoutReturn()).toBe(false);
  });
});
