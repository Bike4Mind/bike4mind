import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { findById, userUpdate, mcpFindOne, mcpUpdate } = vi.hoisted(() => ({
  findById: vi.fn(),
  userUpdate: vi.fn(),
  mcpFindOne: vi.fn(),
  mcpUpdate: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById, update: userUpdate },
  mcpServerRepository: { findOne: mcpFindOne, update: mcpUpdate },
}));
vi.mock('./atlassianConfig', () => ({
  getAtlassianOAuthConfig: vi.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'secret' }),
}));
vi.mock('../../security/tokenEncryption', () => ({
  encryptToken: (v: string | null | undefined) => (v == null ? null : `enc:${v}`),
  decryptToken: (v: string | null | undefined) => (v == null ? null : String(v).replace(/^enc:/, '')),
  encryptEnvVariables: (vars: unknown) => vars,
}));

import { AtlassianTokenManager } from './atlassianTokenManager';

const expiringUser = {
  id: 'user-1',
  atlassianConnect: {
    accessToken: 'enc:old-access',
    refreshToken: 'enc:old-refresh',
    expiresAt: new Date(Date.now() + 60 * 1000),
    status: 'connected',
    selectedResourceId: 'cloud-1',
    resources: [{ id: 'cloud-1', name: 'Site', url: 'https://example.atlassian.net' }],
  },
};

function mockTokenResponse(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('') })
  );
}

describe('AtlassianTokenManager.getValidTokens refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    findById.mockResolvedValue(expiringUser);
    mcpFindOne.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stores the refreshed token and its expiry', async () => {
    mockTokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });

    const result = await AtlassianTokenManager.getValidTokens('user-1');

    expect(result).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      cloudId: 'cloud-1',
      siteUrl: 'https://example.atlassian.net/wiki',
    });
    const saved = userUpdate.mock.calls[0][0].atlassianConnect;
    expect(saved.accessToken).toBe('enc:new-access');
    expect(Number.isNaN(saved.expiresAt.getTime())).toBe(false);
  });

  it('preserves an encrypted existing refresh token when the provider omits a replacement', async () => {
    mockTokenResponse({ access_token: 'new-access', expires_in: 3600 });
    const result = await AtlassianTokenManager.getValidTokens('user-1');
    expect(result?.refreshToken).toBe('old-refresh');
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        atlassianConnect: expect.objectContaining({ refreshToken: 'enc:old-refresh' }),
      })
    );
  });

  it.each([
    ['access_token', { refresh_token: 'new-refresh', expires_in: 3600 }],
    ['expires_in', { access_token: 'new-access', refresh_token: 'new-refresh' }],
  ])('does not persist the connection when %s is missing', async (_field, body) => {
    mockTokenResponse(body);

    const result = await AtlassianTokenManager.getValidTokens('user-1');

    expect(result).toBeNull();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
