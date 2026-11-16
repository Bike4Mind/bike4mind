import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  readEnforceMfa: vi.fn(),
  getMFAStatus: vi.fn(),
  findByIdWithMfaSecrets: vi.fn(),
  requiresOrganizationMfaEnrollment: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    // any: stands in for the next-connect chain; only .get(handler) is used by this route.
    const chain: any = { use: () => chain, get: (fn: unknown) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/auth/signInSecondFactor', () => ({ readEnforceMfa: mocks.readEnforceMfa }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findByIdWithMfaSecrets: mocks.findByIdWithMfaSecrets },
}));
vi.mock('@server/auth/organizationMfa', () => ({
  requiresOrganizationMfaEnrollment: mocks.requiresOrganizationMfaEnrollment,
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: {
    getMFAStatus: mocks.getMFAStatus,
    isMfaEnforcementExempt: (user: { isPersona?: boolean }) => user.isPersona === true,
  },
}));

import handler from '../status';

type Handler = (req: unknown, res: unknown) => Promise<void>;

async function getStatus() {
  const { req, res } = createMocks({ method: 'GET' });
  // any: node-mocks-http requests are not structurally the typed Express request.
  (req as any).user = { id: 'u1' };
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/auth/mfa/status', () => {
  const freshUser = { id: 'u1' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByIdWithMfaSecrets.mockResolvedValue(freshUser);
    mocks.getMFAStatus.mockImplementation(({ enforceMFA }: { enforceMFA: boolean }) => ({
      enforced: enforceMFA,
      required: enforceMFA,
    }));
    mocks.requiresOrganizationMfaEnrollment.mockResolvedValue(false);
  });

  it.each([true, false])('passes enforceMFA=%s from the shared reader into the status computation', async enforced => {
    mocks.readEnforceMfa.mockResolvedValue(enforced);

    const res = await getStatus();

    expect(mocks.getMFAStatus).toHaveBeenCalledWith({ user: freshUser, enforceMFA: enforced });
    expect(res._getJSONData()).toEqual({ enforced, required: enforced });
  });

  it('reports required when a team policy past its grace binds the user, leaving the rest to enforceMFA', async () => {
    mocks.readEnforceMfa.mockResolvedValue(false);
    mocks.requiresOrganizationMfaEnrollment.mockResolvedValue(true);

    const res = await getStatus();

    expect(mocks.getMFAStatus).toHaveBeenCalledWith({ user: freshUser, enforceMFA: false });
    expect(res._getJSONData()).toEqual({ enforced: false, required: true });
  });

  it('does not look up team policies when enforceMFA already requires MFA', async () => {
    mocks.readEnforceMfa.mockResolvedValue(true);
    await getStatus();
    expect(mocks.requiresOrganizationMfaEnrollment).not.toHaveBeenCalled();
  });

  it('keeps a test persona exempt from a team policy', async () => {
    mocks.readEnforceMfa.mockResolvedValue(false);
    mocks.requiresOrganizationMfaEnrollment.mockResolvedValue(true);
    mocks.findByIdWithMfaSecrets.mockResolvedValue({ id: 'u1', isPersona: true });

    const res = await getStatus();

    expect(res._getJSONData()).toEqual({ enforced: false, required: false });
    expect(mocks.requiresOrganizationMfaEnrollment).not.toHaveBeenCalled();
  });

  it('answers 404 without computing a status when the user no longer exists', async () => {
    mocks.findByIdWithMfaSecrets.mockResolvedValue(null);

    const res = await getStatus();

    expect(res._getStatusCode()).toBe(404);
    expect(mocks.getMFAStatus).not.toHaveBeenCalled();
  });
});
