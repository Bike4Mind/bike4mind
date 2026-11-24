import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  request: vi.fn(),
  config: { GITHUB_CLIENT_ID: 'gh-client' as string | undefined, GITHUB_CLIENT_SECRET: 'gh-secret' },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    request = h.request;
  },
}));
vi.mock('@bike4mind/utils/security', () => ({ decryptAtRest: (value: string) => value.replace(/^enc:/, '') }));
vi.mock('../utils/config', () => ({ Config: h.config }));

import { revokeGitHubSignInGrant } from './revokeGitHubSignInGrant';

const github = (over: Record<string, unknown> = {}) =>
  [{ strategy: 'github', id: '42', encrypted: true, accessToken: 'enc:gho_token', ...over }] as never;

describe('revokeGitHubSignInGrant', () => {
  beforeEach(() => {
    h.config.GITHUB_CLIENT_ID = 'gh-client';
    h.request.mockReset().mockResolvedValue({ status: 204 });
  });

  it('deletes the app authorization with the decrypted token and the app credentials', async () => {
    await expect(revokeGitHubSignInGrant(github(), 'deleted user u1')).resolves.toBe('revoked');

    expect(h.request).toHaveBeenCalledWith('DELETE /applications/{client_id}/grant', {
      client_id: 'gh-client',
      access_token: 'gho_token',
      headers: { authorization: `basic ${Buffer.from('gh-client:gh-secret').toString('base64')}` },
    });
  });

  it('passes a legacy plaintext token through', async () => {
    await revokeGitHubSignInGrant(github({ encrypted: false, accessToken: 'gho_plain' }), 'deleted user u1');
    expect(h.request.mock.calls[0][1].access_token).toBe('gho_plain');
  });

  it('does nothing without a GitHub identity or token', async () => {
    await expect(
      revokeGitHubSignInGrant([{ strategy: 'google', id: 'g', accessToken: 'x' }] as never, 'c')
    ).resolves.toBe('no_token');
    await expect(revokeGitHubSignInGrant(github({ accessToken: undefined }), 'c')).resolves.toBe('no_token');
    await expect(revokeGitHubSignInGrant(null, 'c')).resolves.toBe('no_token');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('reports not_configured, without calling GitHub, when the OAuth app is unset', async () => {
    h.config.GITHUB_CLIENT_ID = 'not-configured';
    await expect(revokeGitHubSignInGrant(github(), 'c')).resolves.toBe('not_configured');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('resolves failed instead of throwing when GitHub refuses', async () => {
    h.request.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(revokeGitHubSignInGrant(github(), 'c')).resolves.toBe('failed');
  });
});
