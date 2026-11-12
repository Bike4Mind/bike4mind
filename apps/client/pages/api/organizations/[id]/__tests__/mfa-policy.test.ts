import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  get: vi.fn(),
  getUsers: vi.fn(),
  findById: vi.fn(),
  findUser: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: (fn: typeof mocks.handlers.get) => {
        mocks.handlers.get = fn;
        return chain;
      },
      put: (fn: typeof mocks.handlers.put) => {
        mocks.handlers.put = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: mocks.findById, update: mocks.update },
  userRepository: {},
  User: { find: (...args: unknown[]) => ({ lean: () => mocks.findUser(...args) }) },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { get: mocks.get, getUsers: mocks.getUsers },
  mfaService: { userHasMFAConfigured: (user: { mfa?: { totpEnabled?: boolean } }) => !!user.mfa?.totpEnabled },
}));
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({ recordOrganizationAuditEvent: mocks.audit }));
await import('../mfa-policy');

const org = { id: 'org', userId: 'owner', users: [{ userId: 'member', permissions: ['read'] }], adminUserIds: [] };
const call = async (method: 'get' | 'put', userId: string, body?: unknown) => {
  const { req, res } = createMocks({ method: method === 'get' ? 'GET' : 'PUT', query: { id: 'org' }, body });
  Object.assign(req, { user: { id: userId, isAdmin: false, mfa: null } });
  await mocks.handlers[method](req, res);
  return res._getJSONData();
};

describe('organization MFA policy route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(org);
    mocks.findById.mockResolvedValue(org);
    mocks.getUsers.mockResolvedValue([{ id: 'owner' }, { id: 'member' }]);
    mocks.findUser.mockImplementation(async (filter: { _id: { $in: string[] } }) =>
      filter._id.$in.map(id => ({ _id: id, mfa: { totpEnabled: id === 'owner' } }))
    );
    mocks.audit.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(org);
  });
  it('refuses policy writes by ordinary members without changing or auditing anything', async () => {
    await expect(call('put', 'member', { required: true, graceDays: 0 })).rejects.toThrow('Organization not found');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('stamps a server deadline and strictly awaits the audit', async () => {
    const before = Date.now();
    const result = await call('put', 'owner', { required: true, graceDays: 7 });
    expect(new Date(result.policy.enforceAfter).getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(mocks.audit).toHaveBeenCalledWith({ organizationId: 'org', actorUserId: 'owner', action: 'policy.updated' });
    mocks.audit.mockRejectedValueOnce(new Error('audit failed'));
    await expect(call('put', 'owner', { required: true, graceDays: 0 })).rejects.toThrow('audit failed');
  });
  it('does not reset the deadline on an unchanged save', async () => {
    const policy = { required: true, graceDays: 7, enforceAfter: new Date(1000) };
    mocks.findById.mockResolvedValue({ ...org, mfaPolicy: policy });
    const result = await call('put', 'owner', { required: true, graceDays: 7 });
    expect(result.policy.enforceAfter).toBe(policy.enforceAfter.toISOString());
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each([-1, 31, 0.5])('refuses invalid grace days %s', async graceDays => {
    await expect(call('put', 'owner', { required: true, graceDays })).rejects.toThrow();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('returns only enrollment booleans to administrators, not MFA secrets', async () => {
    const result = await call('get', 'owner');
    expect(result.members).toEqual([
      { userId: 'owner', enrolled: true },
      { userId: 'member', enrolled: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('totpEnabled');
  });
  it('returns only the caller status to a plain member', async () => {
    expect((await call('get', 'member')).members).toEqual([{ userId: 'member', enrolled: false }]);
    expect(mocks.getUsers).not.toHaveBeenCalled();
    expect(mocks.findUser).toHaveBeenCalledWith({ _id: { $in: ['member'] } }, { 'mfa.totpEnabled': 1 });
  });
  it('propagates cross-org read denial', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Organization not found'));
    await expect(call('get', 'outsider')).rejects.toThrow('Organization not found');
    expect(mocks.getUsers).not.toHaveBeenCalled();
  });
});
