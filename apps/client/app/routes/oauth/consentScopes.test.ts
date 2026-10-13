import { describe, it, expect } from 'vitest';
import { toConsentScopes } from './consentScopes';

/**
 * The consent screen must never show fewer permissions than the client is granted, so the
 * unmapped case is the load-bearing one: the server validates scopes against the client's
 * registration, not against this map, so a newly registered scope reaches the UI unmapped.
 */
describe('toConsentScopes', () => {
  it('labels the scopes the map knows and keeps the raw id alongside', () => {
    expect(toConsentScopes(['openid', 'email'])).toEqual([
      { id: 'openid', label: 'Confirm who you are' },
      { id: 'email', label: 'See your email address' },
    ]);
  });

  it('labels the API scopes a third-party app requests at sign-in', () => {
    // ai:generate also pays for text completions via the ai-token exchange, so the label
    // must not read as media-only; me:read must not fall through to its raw id.
    expect(toConsentScopes(['ai:generate', 'me:read'])).toEqual([
      { id: 'ai:generate', label: 'Use your Bike4Mind credits to generate AI responses, images, video and audio' },
      { id: 'me:read', label: 'See your name, plan, subscription, credit balance and feature access' },
    ]);
  });

  it('keeps an unmapped scope with a null label rather than dropping it', () => {
    // A scope registered after this map was last touched. Dropping it would understate the grant.
    expect(toConsentScopes(['openid', 'billing:write'])).toEqual([
      { id: 'openid', label: 'Confirm who you are' },
      { id: 'billing:write', label: null },
    ]);
  });

  it('returns one row per requested scope, in the order the server sent them', () => {
    const requested = ['profile', 'ai:generate', 'openid'];

    expect(toConsentScopes(requested).map(s => s.id)).toEqual(requested);
  });

  it('keeps openid and profile as separate rows', () => {
    // They are separate grants; collapsing them into one line would show the user fewer
    // permissions than the client receives.
    expect(toConsentScopes(['openid', 'profile'])).toHaveLength(2);
  });

  it('returns nothing for an empty scope list', () => {
    expect(toConsentScopes([])).toEqual([]);
  });

  it('does not treat a scope that merely resembles a known one as mapped', () => {
    // Guards against a loose match (prefix/substring) creeping in later: 'email:verify' is a
    // different grant from 'email' and must not borrow its wording.
    expect(toConsentScopes(['email:verify'])).toEqual([{ id: 'email:verify', label: null }]);
  });
});
