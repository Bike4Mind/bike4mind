import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getConfigMock, decryptMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  decryptMock: vi.fn(),
}));

vi.mock('@server/integrations/jira/atlassianConfig', () => ({ getAtlassianOAuthConfig: getConfigMock }));
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: decryptMock }));

import { revokeAtlassianGrant } from './revokeAtlassianGrant';

const fetchMock = vi.fn();

beforeEach(() => {
  getConfigMock.mockReset().mockResolvedValue({ clientId: 'cid', clientSecret: 'secret' });
  decryptMock.mockReset().mockImplementation((v: string) => `plain-${v}`);
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('revokeAtlassianGrant', () => {
  it('posts the decrypted token to the Atlassian revoke endpoint', async () => {
    await expect(revokeAtlassianGrant('enc', 'user u1')).resolves.toBe('revoked');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.atlassian.com/oauth/token/revoke',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ client_id: 'cid', client_secret: 'secret', token: 'plain-enc' }),
      })
    );
  });

  it('does nothing without a stored credential', async () => {
    await expect(revokeAtlassianGrant(undefined, 'user u1')).resolves.toBe('no_credential');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when the OAuth client is not configured', async () => {
    getConfigMock.mockResolvedValue({ clientId: '', clientSecret: '' });

    await expect(revokeAtlassianGrant('enc', 'user u1')).resolves.toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports failure on a non-OK response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 400 }));

    await expect(revokeAtlassianGrant('enc', 'user u1')).resolves.toBe('failed');
  });

  it('never throws, even when the credential is unreadable or Atlassian is unreachable', async () => {
    decryptMock.mockImplementation(() => {
      throw new Error('bad key');
    });
    await expect(revokeAtlassianGrant('enc', 'user u1')).resolves.toBe('failed');

    decryptMock.mockImplementation((v: string) => v);
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(revokeAtlassianGrant('enc', 'user u1')).resolves.toBe('failed');
  });
});
