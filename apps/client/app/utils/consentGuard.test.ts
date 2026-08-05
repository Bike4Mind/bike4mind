import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for issue #382: the consent-redirect guard shared by layoutRoute and the
// standalone rootRoute children (e.g. /admin, /oauth/authorize, the Slack/Atlassian integration
// pages). Exercises the glue - store reads + redirect throw - on top of the already-tested
// shouldRedirectToConsent (see authRedirect.test.ts).

// redirect() is mocked to a plain tagged object so the thrown value is inspectable without pulling
// in TanStack Router's real Redirect internals.
vi.mock('@tanstack/react-router', () => ({
  redirect: vi.fn((opts: unknown) => ({ isRedirect: true, ...(opts as object) })),
}));

let userState: { currentUser: { aupAcceptedVersion?: unknown } | null; isHydrated: boolean };
let tokenState: { accessToken: string | null };

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: { getState: () => userState },
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: { getState: () => tokenState },
}));
// The guard awaits the cold-load silent refresh before reading the stores; stub it to a resolved
// no-op so these tests exercise only the gate decision, not the network exchange.
vi.mock('./sessionBootstrap', () => ({ bootstrapSession: () => Promise.resolve() }));

import { enforceConsentRedirect } from './consentGuard';

const TOKEN = 'live-access-token';
const loc = (pathname: string, searchStr = '', hash = '') => ({ pathname, searchStr, hash });

describe('enforceConsentRedirect', () => {
  beforeEach(() => {
    userState = { currentUser: null, isHydrated: true };
    tokenState = { accessToken: TOKEN };
  });

  it('redirects a not-yet-consented account to /accept-policies with a return path', async () => {
    userState = { currentUser: { aupAcceptedVersion: undefined }, isHydrated: true };
    await expect(enforceConsentRedirect(loc('/admin'))).rejects.toThrow(
      expect.objectContaining({ isRedirect: true, to: '/accept-policies', search: { redirectTo: '/admin' } })
    );
  });

  it('preserves the full search string in the return path (the OAuth authorize case)', async () => {
    userState = { currentUser: {}, isHydrated: true };
    await expect(enforceConsentRedirect(loc('/oauth/authorize', '?client_id=abc&response_type=code'))).rejects.toThrow(
      expect.objectContaining({
        to: '/accept-policies',
        search: { redirectTo: '/oauth/authorize?client_id=abc&response_type=code' },
      })
    );
  });

  it('omits redirectTo when the location is not worth preserving (home page)', async () => {
    userState = { currentUser: {}, isHydrated: true };
    await expect(enforceConsentRedirect(loc('/'))).rejects.toThrow(
      expect.objectContaining({ to: '/accept-policies', search: undefined })
    );
  });

  it('does NOT redirect an already-consented account', async () => {
    userState = { currentUser: { aupAcceptedVersion: 'v1' }, isHydrated: true };
    await expect(enforceConsentRedirect(loc('/admin'))).resolves.toBeUndefined();
  });

  it('does NOT redirect a token-less / broken session (goes to /login instead, issue #386)', async () => {
    userState = { currentUser: {}, isHydrated: true };
    tokenState = { accessToken: null };
    await expect(enforceConsentRedirect(loc('/admin'))).resolves.toBeUndefined();
  });

  it('does NOT redirect before the server-confirmed user has hydrated', async () => {
    userState = { currentUser: {}, isHydrated: false };
    await expect(enforceConsentRedirect(loc('/admin'))).resolves.toBeUndefined();
  });

  it('does NOT redirect when there is no user (that path bounces to /login)', async () => {
    userState = { currentUser: null, isHydrated: true };
    await expect(enforceConsentRedirect(loc('/admin'))).resolves.toBeUndefined();
  });
});
