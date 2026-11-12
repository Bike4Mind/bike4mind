import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { RequestHandler } from 'express';

const mocks = vi.hoisted(() => ({
  get: undefined as RequestHandler | undefined,
  put: undefined as RequestHandler | undefined,
  options: undefined as unknown,
  findById: vi.fn(),
  update: vi.fn(),
  findUsers: vi.fn(),
  lean: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mocks.options = options;
    const chain = {
      get: (fn: RequestHandler) => {
        mocks.get = fn;
        return chain;
      },
      put: (fn: RequestHandler) => {
        mocks.put = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: mocks.findById },
  Organization: { findByIdAndUpdate: mocks.update },
}));
vi.mock('@bike4mind/database/auth', () => ({ User: { find: mocks.findUsers } }));
import '../mfa-policy';

const id = '123456789012345678901234';
const org = {
  id,
  userId: 'owner',
  personal: false,
  adminUserIds: ['manager'],
  users: [
    { userId: 'manager', permissions: ['read'] },
    { userId: 'invite', permissions: [] },
  ],
};
async function run(method: 'get' | 'put', userId = 'owner', body: unknown = { required: true, graceDays: 7 }) {
  const { req, res } = createMocks({ query: { id }, body });
  Object.assign(req, { user: { id: userId } });
  await mocks[method]!(
    req as unknown as Parameters<RequestHandler>[0],
    res as unknown as Parameters<RequestHandler>[1],
    vi.fn()
  );
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue(org);
  mocks.update.mockImplementation(async (_id, update) => ({ ...org, ...update.$set }));
  mocks.findUsers.mockReturnValue({ lean: mocks.lean });
  mocks.lean.mockResolvedValue([
    { _id: 'owner', name: 'Owner', mfa: { totpEnabled: true, totpSecret: 'not-returned' } },
  ]);
});

describe('organization MFA policy', () => {
  it('uses first-party JWT auth only', () => expect(mocks.options).toEqual({ auth: 'jwtOnly' }));
  it.each(['owner', 'manager'])('allows %s to configure a server-calculated deadline', async userId => {
    const start = Date.now();
    const res = await run('put', userId);
    expect(res._getJSONData().mfaPolicy.required).toBe(true);
    const deadline = mocks.update.mock.calls[0][1].$set.mfaPolicy.graceEndsAt.getTime();
    expect(deadline).toBeGreaterThanOrEqual(start + 7 * 86_400_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
  });
  it('supports immediate enrollment and disabling', async () => {
    await run('put', 'owner', { required: true, graceDays: 0 });
    const res = await run('put', 'owner', { required: false, graceDays: 0 });
    expect(res._getJSONData().mfaPolicy).toEqual({ required: false, graceEndsAt: null });
  });
  it.each([-1, 31, 0.5, '7'])('rejects invalid grace %s', async graceDays => {
    await expect(run('put', 'owner', { required: true, graceDays })).rejects.toThrow();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(['get', 'put'] as const)('refuses ordinary members on %s', async method => {
    await expect(run(method, 'member')).rejects.toThrow('Organization admin required');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.findUsers).not.toHaveBeenCalled();
  });
  it('returns only enrollment booleans and identity for actual members', async () => {
    const res = await run('get');
    expect(res._getJSONData()).toEqual({ members: [{ id: 'owner', name: 'Owner', mfaEnabled: true }] });
    expect(mocks.findUsers).toHaveBeenCalledWith(
      { _id: { $in: ['owner', 'manager'] }, serviceAccountOrganizationId: null },
      { _id: 1, name: 1, 'mfa.totpEnabled': 1 }
    );
  });
});
