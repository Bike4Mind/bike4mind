// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// Fresh module per test: the taken tokens live in module state.
const load = () => import('./emailLinkToken');

describe('takeEmailLinkToken', () => {
  afterEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/');
  });

  it('takes the token from the fragment and clears it from the address', async () => {
    const { takeEmailLinkToken, getEmailLinkToken } = await load();
    window.history.replaceState(null, '', '/verify-email#token=frag-1');

    expect(takeEmailLinkToken('/verify-email')).toBe('frag-1');
    expect(window.location.href).not.toContain('frag-1');
    expect(window.location.hash).toBe('');
    expect(getEmailLinkToken('/verify-email')).toBe('frag-1');
  });

  it('falls back to a ?token= link sent before the fragment form, dropping only the token', async () => {
    const { takeEmailLinkToken, getEmailLinkToken } = await load();
    window.history.replaceState(null, '', '/verify-change?token=query-1&utm_source=email');

    expect(takeEmailLinkToken('/verify-change')).toBe('query-1');
    expect(window.location.search).toBe('?utm_source=email');
    expect(window.location.href).not.toContain('query-1');
    expect(getEmailLinkToken('/verify-change')).toBe('query-1');
  });

  it('prefers the fragment over the query and strips both', async () => {
    const { takeEmailLinkToken } = await load();
    window.history.replaceState(null, '', '/verify-email?token=query-2#token=frag-2&x=1');

    expect(takeEmailLinkToken('/verify-email')).toBe('frag-2');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#x=1');
  });

  it('returns the token already taken when it runs again on a clean address', async () => {
    const { takeEmailLinkToken } = await load();
    window.history.replaceState(null, '', '/verify-email#token=frag-3');
    takeEmailLinkToken('/verify-email');

    expect(takeEmailLinkToken('/verify-email')).toBe('frag-3');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/verify-email');
  });

  it('keeps each route its own token and returns nothing when no link token arrived', async () => {
    const { takeEmailLinkToken, getEmailLinkToken } = await load();
    window.history.replaceState(null, '', '/verify-change');

    expect(takeEmailLinkToken('/verify-change')).toBeUndefined();
    expect(getEmailLinkToken('/verify-email')).toBeUndefined();
  });
});
