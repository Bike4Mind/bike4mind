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

  it('splices params before a fragment rather than into it', () => {
    // Appending after `#...` buries the params in the fragment, where the browser
    // never exposes them as query params - the whole success path would no-op.
    expect(appendSuccessParams('https://app.example.com/#/notebooks/abc')).toBe(
      'https://app.example.com/?subscription_success=true&checkout_session_id={CHECKOUT_SESSION_ID}#/notebooks/abc'
    );
  });

  it('preserves an existing query alongside a fragment', () => {
    expect(appendSuccessParams('https://app.example.com/?redirectTo=/x#frag')).toBe(
      'https://app.example.com/?redirectTo=/x&subscription_success=true&checkout_session_id={CHECKOUT_SESSION_ID}#frag'
    );
  });

  it('leaves the Stripe template literal - encoded braces would never be substituted', () => {
    const url = appendSuccessParams('https://app.example.com');
    expect(url).toContain('{CHECKOUT_SESSION_ID}');
    expect(url).not.toContain('%7B');
  });
});
