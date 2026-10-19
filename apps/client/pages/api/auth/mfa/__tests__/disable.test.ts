import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  readEnforceMfa: vi.fn(),
  userCanDisableMFA: vi.fn(),
  disableMFA: vi.fn(),
  findById: vi.fn(),
  removeAllForUser: vi.fn(),
  revokeUserSessions: vi.fn(),
  revokeAllForUser: vi.fn(),
  logAuthAudit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    // any: stands in for the next-connect chain; only .post(handler) is used by this route.
    const chain: any = { use: () => chain, post: (fn: unknown) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/auth/signInSecondFactor', () => ({ readEnforceMfa: mocks.readEnforceMfa }));
vi.mock('@server/auth/trustedDevice', () => ({ clearTrustedDeviceCookie: vi.fn() }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: mocks.logAuthAudit }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.findById },
  authSessionRepository: {},
  realtimeConnectionRepository: {},
  trustedDeviceRepository: { revokeAllForUser: mocks.revokeAllForUser },
  passkeyCredentialRepository: { removeAllForUser: mocks.removeAllForUser },
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userCanDisableMFA: mocks.userCanDisableMFA, disableMFA: mocks.disableMFA },
  userService: { revokeUserSessions: mocks.revokeUserSessions },
}));

import handler from '../disable';

type Handler = (req: unknown, res: unknown) => Promise<void>;

async function postDisable() {
  const { req, res } = createMocks({ method: 'POST' });
  // any: node-mocks-http requests are not structurally the typed Express request.
  (req as any).user = { id: 'u1' };
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('POST /api/auth/mfa/disable', () => {
  const freshUser = { id: 'u1', mfa: { totpEnabled: true } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue(freshUser);
    mocks.userCanDisableMFA.mockReturnValue(true);
    mocks.disableMFA.mockResolvedValue({ success: true });
    mocks.removeAllForUser.mockResolvedValue(0);
    mocks.revokeAllForUser.mockResolvedValue(0);
  });

  it.each([true, false])('hands enforceMFA=%s from the shared reader to both service calls', async enforced => {
    mocks.readEnforceMfa.mockResolvedValue(enforced);

    await postDisable();

    expect(mocks.userCanDisableMFA).toHaveBeenCalledWith(freshUser, enforced);
    expect(mocks.disableMFA).toHaveBeenCalledWith(
      expect.objectContaining({ user: freshUser, enforceMFA: enforced }),
      expect.anything()
    );
  });

  it('surfaces the service refusal as a 400 when the policy enforces MFA', async () => {
    mocks.readEnforceMfa.mockResolvedValue(true);
    mocks.userCanDisableMFA.mockReturnValue(false);
    mocks.disableMFA.mockRejectedValue(new Error('MFA is required by your administrator'));

    const res = await postDisable();

    expect(res._getStatusCode()).toBe(400);
    expect(mocks.removeAllForUser).not.toHaveBeenCalled();
    expect(mocks.revokeUserSessions).not.toHaveBeenCalled();
  });
});
