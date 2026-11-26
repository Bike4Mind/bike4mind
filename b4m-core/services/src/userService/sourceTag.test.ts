import { describe, it, expect, vi } from 'vitest';
import { oauthSourceTagFor, resolveActiveOAuthClientId, resolveOAuthSourceTag } from './sourceTag';

const lookupReturning = (client: { clientId: string; isActive: boolean } | null) => ({
  findByClientId: vi.fn().mockResolvedValue(client),
});

describe('resolveOAuthSourceTag', () => {
  it('tags an active client with the slug from its stored id', async () => {
    const lookup = lookupReturning({ clientId: 'b4m_acme_app_0a1b2c3d', isActive: true });
    await expect(resolveOAuthSourceTag('b4m_acme_app_0a1b2c3d', lookup)).resolves.toBe('source:acme_app');
    expect(lookup.findByClientId).toHaveBeenCalledWith('b4m_acme_app_0a1b2c3d');
  });

  it('takes the slug from the stored record, not the requested id', async () => {
    const lookup = lookupReturning({ clientId: 'b4m_real_0a1b2c3d', isActive: true });
    await expect(resolveOAuthSourceTag('b4m_spoofed_0a1b2c3d', lookup)).resolves.toBe('source:real');
  });

  it('returns null for an inactive client', async () => {
    const lookup = lookupReturning({ clientId: 'b4m_acme_0a1b2c3d', isActive: false });
    await expect(resolveOAuthSourceTag('b4m_acme_0a1b2c3d', lookup)).resolves.toBeNull();
  });

  it('returns null for an unknown client', async () => {
    await expect(resolveOAuthSourceTag('b4m_nope_0a1b2c3d', lookupReturning(null))).resolves.toBeNull();
  });

  it.each([undefined, null, '', 42, {}, ['b4m_acme_0a1b2c3d'], 'b4m_acme_0a1b2c3d\nforged'])(
    'returns null without a lookup for %p',
    async value => {
      const lookup = lookupReturning({ clientId: 'b4m_acme_0a1b2c3d', isActive: true });
      await expect(resolveOAuthSourceTag(value, lookup)).resolves.toBeNull();
      expect(lookup.findByClientId).not.toHaveBeenCalled();
    }
  );
});

describe('resolveActiveOAuthClientId', () => {
  it('returns the stored id of an active client', async () => {
    const lookup = lookupReturning({ clientId: 'b4m_real_0a1b2c3d', isActive: true });
    await expect(resolveActiveOAuthClientId('b4m_spoofed_0a1b2c3d', lookup)).resolves.toBe('b4m_real_0a1b2c3d');
  });

  it('returns null for an inactive or unknown client, or a malformed id', async () => {
    const inactive = lookupReturning({ clientId: 'b4m_acme_0a1b2c3d', isActive: false });
    await expect(resolveActiveOAuthClientId('b4m_acme_0a1b2c3d', inactive)).resolves.toBeNull();
    await expect(resolveActiveOAuthClientId('b4m_nope_0a1b2c3d', lookupReturning(null))).resolves.toBeNull();
    await expect(resolveActiveOAuthClientId('not an id', inactive)).resolves.toBeNull();
  });
});

describe('oauthSourceTagFor', () => {
  it('returns null when the id yields no slug', () => {
    expect(oauthSourceTagFor('')).toBeNull();
  });
});
