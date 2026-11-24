import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  consumeValidCode: vi.fn(),
  findLiveSids: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  oauthAuthorizationCodeRepository: { create: h.create, consumeValidCode: h.consumeValidCode },
  authSessionRepository: { findLiveSids: h.findLiveSids },
}));

const { DESKTOP_WEB_SESSION_CLIENT_ID, mintDesktopWebSessionCode, redeemDesktopWebSessionCode } =
  await import('./desktopWebSession');

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const USER_ID = '64b000000000000000000001';
const PARENT_SID = 'parent-sid';

beforeEach(() => {
  vi.clearAllMocks();
  h.findLiveSids.mockResolvedValue(new Set([PARENT_SID]));
});

describe('mintDesktopWebSessionCode', () => {
  it('stores only a hash of the code, bound to the user and parent session, for 60 seconds', async () => {
    const before = Date.now();
    const code = await mintDesktopWebSessionCode({ userId: USER_ID, parentSid: PARENT_SID });

    expect(code).toMatch(/^[\w-]{43}$/);
    const stored = h.create.mock.calls[0][0];
    expect(stored).toMatchObject({
      code: sha256(code),
      clientId: DESKTOP_WEB_SESSION_CLIENT_ID,
      userId: USER_ID,
      nonce: PARENT_SID,
      used: false,
    });
    expect(stored.code).not.toBe(code);
    const ttlMs = stored.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(55_000);
    expect(ttlMs).toBeLessThanOrEqual(60_000 + 1000);
  });
});

describe('redeemDesktopWebSessionCode', () => {
  const claimed = { clientId: DESKTOP_WEB_SESSION_CLIENT_ID, userId: USER_ID, nonce: PARENT_SID };

  it('consumes the hashed code and returns its user while the parent session is live', async () => {
    h.consumeValidCode.mockResolvedValue(claimed);

    await expect(redeemDesktopWebSessionCode('the-code')).resolves.toEqual({ userId: USER_ID });
    expect(h.consumeValidCode).toHaveBeenCalledWith(sha256('the-code'));
    expect(h.findLiveSids).toHaveBeenCalledWith([PARENT_SID]);
  });

  it('refuses an unknown, spent or expired code', async () => {
    h.consumeValidCode.mockResolvedValue(null);
    await expect(redeemDesktopWebSessionCode('the-code')).resolves.toBeNull();
  });

  it('refuses a code minted for another OAuth client', async () => {
    h.consumeValidCode.mockResolvedValue({ ...claimed, clientId: 'b4m-desktop' });
    await expect(redeemDesktopWebSessionCode('the-code')).resolves.toBeNull();
  });

  it('refuses a code whose Desktop session has been revoked or expired since it was minted', async () => {
    h.consumeValidCode.mockResolvedValue(claimed);
    h.findLiveSids.mockResolvedValue(new Set());
    await expect(redeemDesktopWebSessionCode('the-code')).resolves.toBeNull();
  });

  it('refuses a code with no parent session recorded', async () => {
    h.consumeValidCode.mockResolvedValue({ ...claimed, nonce: undefined });
    await expect(redeemDesktopWebSessionCode('the-code')).resolves.toBeNull();
    expect(h.findLiveSids).not.toHaveBeenCalled();
  });
});
