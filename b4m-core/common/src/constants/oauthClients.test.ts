import { describe, it, expect } from 'vitest';
import { LEGACY_DEVICE_CLIENT_ID, OAUTH_DEVICE_CLIENT_IDS, oauthClientDisplayName } from './oauthClients';

describe('oauthClientDisplayName', () => {
  it('names every allowlisted client', () => {
    expect(oauthClientDisplayName('b4m-cli')).toBe('B4M CLI');
    expect(oauthClientDisplayName('b4m-desktop')).toBe('B4M Desktop');
  });

  it('falls through to the raw slug for an unknown client', () => {
    expect(oauthClientDisplayName('b4m-rogue')).toBe('b4m-rogue');
    expect(oauthClientDisplayName('')).toBe('');
  });

  // Consent copy, so every id the allowlist admits has to resolve to something
  // written for a human rather than the slug fallback.
  it('leaves no allowlisted id on the slug fallback', () => {
    for (const id of OAUTH_DEVICE_CLIENT_IDS) {
      expect(oauthClientDisplayName(id)).not.toBe(id);
    }
  });

  it('treats the pre-clientId row default as an allowlisted client', () => {
    expect(OAUTH_DEVICE_CLIENT_IDS).toContain(LEGACY_DEVICE_CLIENT_ID);
  });
});
