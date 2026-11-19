// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// Fresh module per test: the taken token lives in module state.
const land = async (href: string) => {
  window.history.replaceState(null, '', href);
  const mod = await import('./emailLinkToken');
  mod.captureEmailLinkToken();
  return mod;
};

describe('captureEmailLinkToken', () => {
  afterEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/');
  });

  it('takes the token from the fragment and clears it from the address', async () => {
    const { getEmailLinkToken } = await land('/verify-email#token=frag-1');

    expect(getEmailLinkToken('/verify-email')).toBe('frag-1');
    expect(window.location.href).not.toContain('frag-1');
    expect(window.location.hash).toBe('');
  });

  it('falls back to a ?token= link sent before the fragment form, dropping only the token', async () => {
    const { getEmailLinkToken } = await land('/verify-change?token=query-1&utm_source=email');

    expect(getEmailLinkToken('/verify-change')).toBe('query-1');
    expect(window.location.search).toBe('?utm_source=email');
    expect(window.location.href).not.toContain('query-1');
  });

  it('prefers the fragment over the query and strips both', async () => {
    const { getEmailLinkToken } = await land('/verify-email?token=query-2#token=frag-2&x=1');

    expect(getEmailLinkToken('/verify-email')).toBe('frag-2');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#x=1');
  });

  it('accepts a trailing slash on the path', async () => {
    const { getEmailLinkToken } = await land('/verify-email/#token=frag-3');

    expect(getEmailLinkToken('/verify-email')).toBe('frag-3');
    expect(window.location.hash).toBe('');
  });

  it('matches the path case-insensitively, as the routes do', async () => {
    const { getEmailLinkToken } = await land('/Verify-Email#token=frag-5');

    expect(getEmailLinkToken('/verify-email')).toBe('frag-5');
    expect(window.location.hash).toBe('');
  });

  it('clears a token written back into the address again, keeping the one it took', async () => {
    const { captureEmailLinkToken, getEmailLinkToken } = await land('/verify-email?token=query-6');
    window.history.replaceState(null, '', '/verify-email?token=query-6');

    captureEmailLinkToken();

    expect(window.location.search).toBe('');
    expect(getEmailLinkToken('/verify-email')).toBe('query-6');
  });

  it('gives the token only to the page the link landed on', async () => {
    const { getEmailLinkToken } = await land('/verify-change#token=frag-4');

    expect(getEmailLinkToken('/verify-email')).toBeUndefined();
    expect(getEmailLinkToken('/verify-change')).toBe('frag-4');
  });

  it('leaves a token param on any other page alone', async () => {
    const { getEmailLinkToken } = await land('/email/preferences?token=keep-me');

    expect(window.location.search).toBe('?token=keep-me');
    expect(getEmailLinkToken('/verify-email')).toBeUndefined();
    expect(getEmailLinkToken('/email/unsubscribe')).toBeUndefined();
  });

  it('leaves the address alone and takes nothing when the link page has no token', async () => {
    const { getEmailLinkToken } = await land('/email/unsubscribe?x=1#other=1');

    expect(getEmailLinkToken('/email/unsubscribe')).toBeUndefined();
    expect(window.location.search + window.location.hash).toBe('?x=1#other=1');
  });
});

describe('captureEmailLinkToken on /email/unsubscribe', () => {
  afterEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/');
  });

  it('takes the token from the fragment and clears it from the address', async () => {
    const { getEmailLinkToken } = await land('/email/unsubscribe?x=1#token=unsub-frag');

    expect(getEmailLinkToken('/email/unsubscribe')).toBe('unsub-frag');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/email/unsubscribe?x=1');
  });

  it('still accepts a ?token= link sent before the fragment form, dropping only the token', async () => {
    const { getEmailLinkToken } = await land('/email/unsubscribe?token=unsub-query&x=1');

    expect(getEmailLinkToken('/email/unsubscribe')).toBe('unsub-query');
    expect(window.location.pathname + window.location.search).toBe('/email/unsubscribe?x=1');
  });

  it('prefers the fragment over the query and strips both', async () => {
    const { getEmailLinkToken } = await land('/email/unsubscribe?token=unsub-old#token=unsub-new');

    expect(getEmailLinkToken('/email/unsubscribe')).toBe('unsub-new');
    expect(window.location.search + window.location.hash).toBe('');
  });

  it('matches a trailing slash and any case, as the route does', async () => {
    const { getEmailLinkToken } = await land('/Email/Unsubscribe/#token=unsub-case');

    expect(getEmailLinkToken('/email/unsubscribe')).toBe('unsub-case');
    expect(window.location.hash).toBe('');
  });

  it('gives the token only to the unsubscribe page', async () => {
    const { getEmailLinkToken } = await land('/email/unsubscribe#token=unsub-only');

    expect(getEmailLinkToken('/verify-email')).toBeUndefined();
    expect(getEmailLinkToken('/verify-change')).toBeUndefined();
    expect(getEmailLinkToken('/email/unsubscribe')).toBe('unsub-only');
  });
});
