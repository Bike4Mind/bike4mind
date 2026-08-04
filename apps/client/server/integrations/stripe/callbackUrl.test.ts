import { describe, it, expect } from 'vitest';
import { appendSuccessParams } from './callbackUrl';

describe('appendSuccessParams', () => {
  it('adds the success marker and session template to a bare url', () => {
    expect(appendSuccessParams('https://app.example.com')).toBe(
      'https://app.example.com?subscription_success=true&checkout_session_id={CHECKOUT_SESSION_ID}'
    );
  });

  it('joins with & when the callback already carries a query', () => {
    expect(appendSuccessParams('https://app.example.com/?redirectTo=/x')).toBe(
      'https://app.example.com/?redirectTo=/x&subscription_success=true&checkout_session_id={CHECKOUT_SESSION_ID}'
    );
  });

  it('leaves the Stripe template literal - encoded braces would never be substituted', () => {
    const url = appendSuccessParams('https://app.example.com');
    expect(url).toContain('{CHECKOUT_SESSION_ID}');
    expect(url).not.toContain('%7B');
  });
});
