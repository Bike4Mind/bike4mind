import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  FEDERATED_ADMIN_STATUS_SCOPE,
  HOST_DEVICE_CLIENT_ID,
  LEGACY_DEVICE_CLIENT_ID,
  OAUTH_CLIENT_SCOPES,
  OAUTH_DEVICE_CLIENT_IDS,
  OAUTH_FEDERATED_DEFAULT_SCOPES,
  OAUTH_FUNCTIONS_SCOPES,
  OAUTH_IDENTITY_SCOPES,
  clientIdFromAuthorizeRedirect,
  isOAuthClientIdShape,
  isOAuthSourceTag,
  nonOptInScopes,
  oauthClientDisplayName,
  oauthClientSourceSlug,
} from './oauthClients';
import { ApiKeyScope, EXCHANGE_KEY_COMBINABLE_CONFINED_SCOPES } from '../types/entities/UserApiKeyTypes';

describe('oauthClientDisplayName', () => {
  it('names every allowlisted client', () => {
    expect(oauthClientDisplayName('b4m-cli')).toBe('B4M CLI');
    expect(oauthClientDisplayName('b4m-desktop')).toBe('B4M Desktop');
    expect(oauthClientDisplayName('b4m-host')).toBe('B4M Host');
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

describe('device client allowlist', () => {
  // The device routes parse client_id with exactly this schema.
  const clientIdSchema = z.enum(OAUTH_DEVICE_CLIENT_IDS);

  it('accepts the headless host alongside the CLI and Desktop', () => {
    expect(HOST_DEVICE_CLIENT_ID).toBe('b4m-host');
    for (const id of ['b4m-cli', 'b4m-desktop', 'b4m-host']) {
      expect(clientIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('still rejects an unknown id', () => {
    expect(clientIdSchema.safeParse('b4m-rogue').success).toBe(false);
    expect(clientIdSchema.safeParse('').success).toBe(false);
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

  it('lets an admin grant the functions scopes, never by default, and only ones an exchange key may carry', () => {
    expect(OAUTH_FUNCTIONS_SCOPES).toEqual([ApiKeyScope.FUNCTIONS_INVOKE, ApiKeyScope.FUNCTIONS_AUTHOR]);
    expect(nonOptInScopes(OAUTH_FUNCTIONS_SCOPES)).toEqual([]);
    expect(OAUTH_CLIENT_SCOPES).toEqual(expect.arrayContaining([...OAUTH_FUNCTIONS_SCOPES]));
    expect([...OAUTH_IDENTITY_SCOPES, ...OAUTH_FEDERATED_DEFAULT_SCOPES]).not.toEqual(
      expect.arrayContaining([ApiKeyScope.FUNCTIONS_INVOKE])
    );
    expect([...EXCHANGE_KEY_COMBINABLE_CONFINED_SCOPES]).toEqual([...OAUTH_FUNCTIONS_SCOPES]);
  });
});
