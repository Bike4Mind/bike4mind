import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  updateOne: vi.fn(),
  record: vi.fn(),
  stepUp: vi.fn(),
  lock: vi.fn(),
  guard: vi.fn(),
}));
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Middleware = (req: unknown, res: unknown, next: () => void) => void;
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: (middleware: Middleware) => ({
      put: (handler: Handler) => async (req: unknown, res: unknown) => {
        middleware(req, res, () => {});
        return handler(req, res);
      },
    }),
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (handler: Handler) => handler }));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: mocks.stepUp }));
vi.mock('@bike4mind/database', () => ({
  User: {
    findById: () => ({ select: () => ({ lean: mocks.findById }) }),
    updateOne: mocks.updateOne,
  },
  withTransaction: async (change: () => Promise<unknown>) => change(),
  prepareAdminMutationLock: vi.fn(),
  lockAdminMutations: mocks.lock,
  assertCanRemoveFullAdmin: mocks.guard,
}));
vi.mock('@server/utils/adminAudit', async original => ({
  ...(await original<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: mocks.record,
}));
import { ADMIN_PERMISSIONS } from '@bike4mind/common';
import handler from '../permissions';
const targetId = '123456789012345678901234';
const actorId = 'abcdefabcdefabcdefabcdef';
const invoke = (
  options: {
    user?: { id: string; isAdmin?: boolean; adminPermissions?: string[] };
    body?: unknown;
    apiKeyInfo?: { scopes: string[] };
  } = {}
) => {
  const { req, res } = createMocks({
    method: 'PUT',
    query: { userId: targetId },
    body: options.body ?? { isAdmin: false, adminPermissions: ['support:read'], reason: 'Assign support duties' },
  });
  Object.assign(req, {
    user: options.user ?? { id: actorId, adminPermissions: ['settings:manage', 'support:read'] },
    apiKeyInfo: options.apiKeyInfo,
  });
  return { res, result: (handler as unknown as Handler)(req, res) };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ _id: targetId, name: 'Target', isAdmin: false, adminPermissions: [] });
  mocks.updateOne.mockResolvedValue({ matchedCount: 1 });
  mocks.record.mockResolvedValue(undefined);
  mocks.guard.mockResolvedValue(undefined);
  mocks.stepUp.mockResolvedValue(undefined);
});

describe('PUT admin user permissions', () => {
  it('allows delegated settings managers and records both old and new grants', async () => {
    const { res, result } = invoke();
    await result;
    expect(res._getJSONData()).toEqual({ isAdmin: false, adminPermissions: ['support:read'] });
    expect(mocks.guard).toHaveBeenCalledWith(targetId);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.permissions.updated',
        reason: 'Assign support duties',
        target: expect.objectContaining({ id: targetId }),
        changes: [
          { field: 'isAdmin', before: false, after: false },
          { field: 'adminPermissions', before: [], after: ['support:read'] },
        ],
      })
    );
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.findById.mock.invocationCallOrder[0]);
    expect(mocks.stepUp.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateOne.mock.invocationCallOrder[0]);
  });

  it('allows legacy administrators without explicit grants', async () => {
    await invoke({ user: { id: actorId, isAdmin: true } }).result;
    expect(mocks.updateOne).toHaveBeenCalled();
  });

  it('lets a full admin demote another full admin through the last-admin guard', async () => {
    mocks.findById.mockResolvedValue({ _id: targetId, name: 'Target', isAdmin: true, adminPermissions: [] });
    await invoke({ user: { id: actorId, isAdmin: true } }).result;
    expect(mocks.guard).toHaveBeenCalledWith(targetId);
    expect(mocks.updateOne).toHaveBeenCalled();
  });

  it.each([
    ['a full admin', { isAdmin: true, adminPermissions: [] }],
    ['a delegated admin', { isAdmin: false, adminPermissions: ['support:read'] }],
  ])('refuses a settings:manage-only actor changing %s', async (_label, target) => {
    mocks.findById.mockResolvedValue({ _id: targetId, name: 'Target', ...target });
    await expect(
      invoke({ user: { id: actorId, adminPermissions: [...ADMIN_PERMISSIONS] } }).result
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('Only full administrators') });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('refuses a delegated actor granting the full-admin flag', async () => {
    const body = { isAdmin: true, adminPermissions: [], reason: 'Promote' };
    await expect(
      invoke({ user: { id: actorId, adminPermissions: [...ADMIN_PERMISSIONS] }, body }).result
    ).rejects.toMatchObject({ statusCode: 403, message: 'Only full administrators can grant full admin access' });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('refuses a delegated actor granting a permission it does not hold', async () => {
    const body = { isAdmin: false, adminPermissions: ['support:read', 'users:delete'], reason: 'Escalate' };
    await expect(invoke({ body }).result).rejects.toMatchObject({
      statusCode: 403,
      message: 'Cannot grant permissions you do not hold: users:delete',
    });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('denies support-only actors before writing', async () => {
    await expect(invoke({ user: { id: actorId, adminPermissions: ['support:read'] } }).result).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('denies self promotion', async () => {
    await expect(invoke({ user: { id: targetId, isAdmin: true } }).result).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    { isAdmin: false, adminPermissions: ['unknown:grant'], reason: 'Support duties' },
    { isAdmin: false, adminPermissions: ['support:read'], reason: '' },
    { isAdmin: false, adminPermissions: ['support:read'], reason: 'Support duties', unsupported: true },
  ])('rejects invalid grant mutations', async body => {
    await expect(invoke({ body }).result).rejects.toThrow();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('rejects API key callers even with the admin scope', async () => {
    await expect(invoke({ apiKeyInfo: { scopes: ['admin'] } }).result).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('does not return success when the strict audit fails', async () => {
    mocks.record.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(invoke().result).rejects.toThrow('audit unavailable');
  });

  it('does not write when the last full admin guard fails', async () => {
    mocks.guard.mockRejectedValueOnce(new Error('last full admin'));
    await expect(invoke().result).rejects.toThrow('last full admin');
    expect(mocks.updateOne).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
