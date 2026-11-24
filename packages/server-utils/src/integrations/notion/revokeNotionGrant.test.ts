import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ settings: {} as Record<string, string | undefined> }));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: async () => h.settings,
  getSettingsValue: (key: string, settings: Record<string, string | undefined>) => settings[key],
}));
vi.mock('../../security/tokenEncryption', () => ({
  decryptToken: (value: string) => {
    if (value.startsWith('bad:')) throw new Error('decryption failed');
    return value.replace(/^enc:/, '');
  },
}));

import { revokeNotionGrant } from './revokeNotionGrant';

describe('revokeNotionGrant', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    h.settings = { notionClientId: 'cid', notionClientSecret: 'csecret' };
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the decrypted token to the revoke endpoint with the client credentials', async () => {
    await expect(revokeNotionGrant('enc:ntn-token', 'deleted user u1')).resolves.toBe('revoked');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/oauth/revoke');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(init.headers['Notion-Version']).toBeTruthy();
    expect(JSON.parse(init.body)).toEqual({ token: 'ntn-token' });
  });

  it('does nothing without a stored token', async () => {
    await expect(revokeNotionGrant(undefined, 'deleted user u1')).resolves.toBe('no_credential');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not_configured, without calling Notion, when the client is unset', async () => {
    h.settings = {};
    await expect(revokeNotionGrant('enc:ntn-token', 'deleted user u1')).resolves.toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves failed instead of throwing when Notion refuses, the network fails or the token will not decrypt', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, body: { cancel: vi.fn() } });
    await expect(revokeNotionGrant('enc:ntn-token', 'deleted user u1')).resolves.toBe('failed');

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(revokeNotionGrant('enc:ntn-token', 'deleted user u1')).resolves.toBe('failed');

    await expect(revokeNotionGrant('bad:ntn-token', 'deleted user u1')).resolves.toBe('failed');
  });
});
