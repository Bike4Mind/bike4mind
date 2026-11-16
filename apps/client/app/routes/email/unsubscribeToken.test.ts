// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

async function load() {
  return import('./unsubscribeToken');
}

describe('captureUnsubscribeToken', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('takes the token from the fragment and clears it from the address', async () => {
    const { captureUnsubscribeToken, getCapturedUnsubscribeToken } = await load();
    window.history.replaceState(null, '', '/email/unsubscribe?x=1#token=abc');

    captureUnsubscribeToken();

    expect(getCapturedUnsubscribeToken()).toBe('abc');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/email/unsubscribe?x=1');
  });

  it('accepts a legacy ?token= link and strips it from the address', async () => {
    const { captureUnsubscribeToken, getCapturedUnsubscribeToken } = await load();
    window.history.replaceState(null, '', '/email/unsubscribe?token=legacy&x=1');

    captureUnsubscribeToken();

    expect(getCapturedUnsubscribeToken()).toBe('legacy');
    expect(window.location.pathname + window.location.search).toBe('/email/unsubscribe?x=1');
  });

  it('prefers the fragment over a query token', async () => {
    const { captureUnsubscribeToken, getCapturedUnsubscribeToken } = await load();
    window.history.replaceState(null, '', '/email/unsubscribe?token=legacy#token=fresh');

    captureUnsubscribeToken();

    expect(getCapturedUnsubscribeToken()).toBe('fresh');
    expect(window.location.search).toBe('');
  });

  it('leaves the address alone and captures nothing without a token', async () => {
    const { captureUnsubscribeToken, getCapturedUnsubscribeToken } = await load();
    window.history.replaceState(null, '', '/email/unsubscribe?x=1#other=1');

    captureUnsubscribeToken();

    expect(getCapturedUnsubscribeToken()).toBeUndefined();
    expect(window.location.search + window.location.hash).toBe('?x=1#other=1');
  });
});
