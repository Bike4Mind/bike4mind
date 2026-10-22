import { describe, it, expect } from 'vitest';
import {
  FEDERATED_ADMIN_STATUS_SCOPE,
  LEGACY_DEVICE_CLIENT_ID,
  OAUTH_DEVICE_CLIENT_IDS,
  clientIdFromAuthorizeRedirect,
  isOAuthClientIdShape,
  isOAuthSourceTag,
  nonOptInScopes,
  oauthClientDisplayName,
  oauthClientSourceSlug,
} from './oauthClients';

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

describe('oauthClientSourceSlug', () => {
  it.each([
    ['b4m_acme_app_0a1b2c3d', 'acme_app'],
    ['b4m_client_deadbeef', 'client'],
    ['b4m_x_12345678', 'x'],
  ])('recovers the slug from a minted id %s', (id, slug) => {
    expect(oauthClientSourceSlug(id)).toBe(slug);
  });

  it.each([
    ['b4m-cli', 'b4m-cli'],
    ['B4M_Acme_ZZZZZZZZ', 'b4m_acme_zzzzzzzz'],
    ['weird id/with:chars', 'weird_id_with_chars'],
  ])('normalizes a non-minted id %s', (id, slug) => {
    expect(oauthClientSourceSlug(id)).toBe(slug);
  });

  it('caps a non-minted slug at 64 chars', () => {
    expect(oauthClientSourceSlug('a'.repeat(200))).toHaveLength(64);
  });
});

describe('clientIdFromAuthorizeRedirect', () => {
  it('returns the client_id of an authorize return path', () => {
    expect(clientIdFromAuthorizeRedirect('/oauth/authorize?client_id=b4m_acme_0a1b2c3d&response_type=code')).toBe(
      'b4m_acme_0a1b2c3d'
    );
  });

  it.each([
    ['protocol-relative', '//evil.example.com/oauth/authorize?client_id=x'],
    ['absolute URL', 'https://evil.example.com/oauth/authorize?client_id=x'],
    ['backslash host', '/\\evil.example.com/oauth/authorize?client_id=x'],
    ['other path', '/settings?client_id=x'],
    ['two client_ids', '/oauth/authorize?client_id=a&client_id=b'],
    ['empty client_id', '/oauth/authorize?client_id='],
    ['no client_id', '/oauth/authorize?response_type=code'],
    ['overlong client_id', `/oauth/authorize?client_id=${'a'.repeat(129)}`],
    ['encoded CR/LF in client_id', '/oauth/authorize?client_id=b4m_x_0a1b2c3d%0D%0Aforged'],
    ['encoded space in client_id', '/oauth/authorize?client_id=a%20b'],
    ['empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(clientIdFromAuthorizeRedirect(value)).toBeUndefined();
  });

  it.each([null, undefined, 42, {}, ['/oauth/authorize?client_id=x']])('rejects non-string %p', value => {
    expect(clientIdFromAuthorizeRedirect(value)).toBeUndefined();
  });
});

describe('isOAuthClientIdShape', () => {
  it.each(['b4m-cli', 'b4m_acme_0a1b2c3d', 'a.b:c-d', 'a'.repeat(128)])('accepts %s', value => {
    expect(isOAuthClientIdShape(value)).toBe(true);
  });

  it.each(['', 'a'.repeat(129), 'b4m_x\r\nforged', 'a b', 'a/b', null, 42])('rejects %p', value => {
    expect(isOAuthClientIdShape(value)).toBe(false);
  });
});

describe('isOAuthSourceTag', () => {
  it.each(['source:acme', 'SOURCE:acme', '  source:x'])('matches %p', tag => {
    expect(isOAuthSourceTag(tag)).toBe(true);
  });

  it.each(['acme:pro', 'opensource:x', 'source', 'vip'])('ignores %p', tag => {
    expect(isOAuthSourceTag(tag)).toBe(false);
  });
});

describe('nonOptInScopes', () => {
  it('returns only the entries that cannot be granted opt-in', () => {
    expect(nonOptInScopes([FEDERATED_ADMIN_STATUS_SCOPE, 'admin:all'])).toEqual(['admin:all']);
  });

  it('returns an empty list for empty input', () => {
    expect(nonOptInScopes([])).toEqual([]);
  });
});
