import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getConfigMock, decryptMock, logger } = vi.hoisted(() => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  getConfigMock: vi.fn(),
  decryptMock: vi.fn(),
}));

vi.mock('@bike4mind/observability', () => ({ Logger: logger }));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianConfig', () => ({
  getAtlassianOAuthConfig: getConfigMock,
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: decryptMock }));

import { revokeAtlassianGrant } from './revokeAtlassianGrant';

const fetchMock = vi.fn();

beforeEach(() => {
  Object.values(logger).forEach(fn => fn.mockReset());
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

  it('logs the upstream status without reading or logging the response body', async () => {
    const response = new Response('secret-upstream-body', { status: 400 });
    const textSpy = vi.spyOn(response, 'text');
    fetchMock.mockResolvedValue(response);

    await revokeAtlassianGrant('enc', 'user u1');

    expect(logger.warn).toHaveBeenCalledWith('[atlassian] revoke failed', { context: 'user u1', status: 400 });
    expect(textSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-upstream-body');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('passes a thrown error as metadata with a static message', async () => {
    const failure = new Error('ECONNRESET');
    fetchMock.mockRejectedValue(failure);

    await revokeAtlassianGrant('enc', 'user u1');

    expect(logger.error).toHaveBeenCalledWith('[atlassian] revoke failed - the token may still be live at Atlassian', {
      context: 'user u1',
      error: failure,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs success at info, not on the console', async () => {
    await revokeAtlassianGrant('enc', 'user u1');

    expect(logger.info).toHaveBeenCalledWith('[atlassian] revoked token at Atlassian', { context: 'user u1' });
    expect(console.log).not.toHaveBeenCalled();
  });
});
