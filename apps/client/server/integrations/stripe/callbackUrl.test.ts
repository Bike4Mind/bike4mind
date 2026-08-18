import { describe, it, expect, afterEach, vi } from 'vitest';
import { appendSuccessParams, isAllowedCallbackOrigin } from './callbackUrl';

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

describe('isAllowedCallbackOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts any path on the configured app origin', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');

    expect(isAllowedCallbackOrigin('https://app.example.com')).toBe(true);
    expect(isAllowedCallbackOrigin('https://app.example.com/settings/billing?x=1#frag')).toBe(true);
  });

  it('rejects a different host, which is the open-redirect this guard exists to stop', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');

    expect(isAllowedCallbackOrigin('https://attacker.example.net/phish')).toBe(false);
    // Origin is scheme + host + port, so a lookalike subdomain and a scheme downgrade both fail.
    expect(isAllowedCallbackOrigin('https://app.example.com.attacker.net/')).toBe(false);
    expect(isAllowedCallbackOrigin('http://app.example.com/')).toBe(false);
  });

  it('rejects anything the URL parser cannot resolve to an origin', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');

    expect(isAllowedCallbackOrigin('/settings/billing')).toBe(false);
    expect(isAllowedCallbackOrigin('not a url')).toBe(false);
    expect(isAllowedCallbackOrigin('')).toBe(false);
  });

  it('fails closed when APP_URL is missing in production', () => {
    // The branch that matters: a stage that lost APP_URL must reject every callback
    // rather than wave all origins through.
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('NODE_ENV', 'production');

    expect(isAllowedCallbackOrigin('https://attacker.example.net/phish')).toBe(false);
  });

  it('passes through when APP_URL is missing outside production (documented dev convenience)', () => {
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('NODE_ENV', 'development');

    expect(isAllowedCallbackOrigin('https://anything.example.net')).toBe(true);
  });
});
