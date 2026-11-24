import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ revoke: vi.fn(), clientArgs: [] as unknown[][] }));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    auth = { revoke: h.revoke };
    constructor(...args: unknown[]) {
      h.clientArgs.push(args);
    }
  },
}));
vi.mock('../../security/tokenEncryption', () => ({
  decryptToken: (value: string) => value.replace(/^enc:/, ''),
}));

import { revokeSlackUserToken } from './revokeSlackUserToken';

describe('revokeSlackUserToken', () => {
  beforeEach(() => {
    h.revoke.mockReset().mockResolvedValue({ ok: true, revoked: true });
    h.clientArgs = [];
  });

  it('calls auth.revoke as the decrypted user token, without retries', async () => {
    await expect(revokeSlackUserToken('enc:xoxp-1', 'deleted user u1')).resolves.toBe('revoked');

    expect(h.clientArgs[0][0]).toBe('xoxp-1');
    expect(h.clientArgs[0][1]).toMatchObject({ retryConfig: { retries: 0 } });
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a stored token', async () => {
    await expect(revokeSlackUserToken(null, 'deleted user u1')).resolves.toBe('no_credential');
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it('resolves failed instead of throwing when the token is already revoked', async () => {
    h.revoke.mockRejectedValue(
      Object.assign(new Error('An API error occurred: token_revoked'), {
        data: { ok: false, error: 'token_revoked' },
      })
    );

    await expect(revokeSlackUserToken('enc:xoxp-1', 'deleted user u1')).resolves.toBe('failed');
  });
});
