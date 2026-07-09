import { describe, it, expect } from 'vitest';
import { shouldRedirectToConsent } from './authRedirect';

describe('shouldRedirectToConsent', () => {
  const unconsented = { aupAcceptedVersion: undefined };
  const consented = { aupAcceptedVersion: 'v1' };

  it('redirects an authenticated, hydrated, unconsented user WITH a live session', () => {
    expect(shouldRedirectToConsent({ currentUser: unconsented, isHydrated: true, hasLiveSession: true })).toBe(true);
  });

  it('does NOT redirect when there is no live session (the /login <-> /accept-policies trap fix)', () => {
    // Stale currentUser persisted past its token: must go to /login, never to the consent gate,
    // which cannot record acceptance without a live authenticated request.
    expect(shouldRedirectToConsent({ currentUser: unconsented, isHydrated: true, hasLiveSession: false })).toBe(false);
  });

  it('does NOT redirect a consented user even with a live session', () => {
    expect(shouldRedirectToConsent({ currentUser: consented, isHydrated: true, hasLiveSession: true })).toBe(false);
  });

  it('does NOT redirect when there is no currentUser', () => {
    expect(shouldRedirectToConsent({ currentUser: null, isHydrated: true, hasLiveSession: true })).toBe(false);
  });

  it('does NOT redirect before hydration (avoids the pre-identify interstitial flash)', () => {
    expect(shouldRedirectToConsent({ currentUser: unconsented, isHydrated: false, hasLiveSession: true })).toBe(false);
  });

  it('requires ALL of: live session, currentUser, hydrated, unconsented', () => {
    // No single condition is sufficient on its own.
    expect(shouldRedirectToConsent({ currentUser: unconsented, isHydrated: false, hasLiveSession: false })).toBe(false);
  });
});
