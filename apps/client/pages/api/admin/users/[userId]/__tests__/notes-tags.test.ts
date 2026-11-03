import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { PENDING_FREE_CREDITS_TAG, RESERVED_PARTNER_RULE_TAGS, hasDeveloperUserTag } from '@bike4mind/common';
import { allKnownEntitlementKeys, grantTagForEntitlement } from '@bike4mind/server-utils/lib/entitlements/registry';

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, (req: Request, res: Response) => Promise<unknown>>>,
  guards: {} as Record<string, (req: Request, res: Response, next: () => void) => void>,
  options: {} as Record<string, unknown>,
  findById: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: { allowedMethods: string[] }) => {
    const key = options.allowedMethods.join(',');
    mocks.options[key] = options;
    mocks.handlers[key] = {};
    const chain = {
      use: (guard: (req: Request, res: Response, next: () => void) => void) => {
        mocks.guards[key] = guard;
        return chain;
      },
      get: (fn: (req: Request, res: Response) => Promise<unknown>) => {
        mocks.handlers[key].GET = fn;
        return chain;
      },
      post: (fn: (req: Request, res: Response) => Promise<unknown>) => {
        mocks.handlers[key].POST = fn;
        return chain;
      },
      patch: (fn: (req: Request, res: Response) => Promise<unknown>) => {
        mocks.handlers[key].PATCH = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: mocks.findById, updateOne: mocks.update },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  AdminUserNoteModel: {},
  AdminUserNoteRevisionModel: {},
  toAdminUserNote: vi.fn(),
  toAdminUserNoteRevision: vi.fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: mocks.audit }));
await import('../notes');
await import('../tags');
const USER = '650000000000000000000001';
const call = async (key: string, method: string, body: unknown, permissions: string[], isAdmin = false) => {
  const { req, res } = createMocks({ method, body, query: { userId: USER } });
  const request = Object.assign(req, {
    user: { id: 'admin1', isAdmin, adminPermissions: permissions },
  }) as unknown as Request;
  mocks.guards[key](request, res as unknown as Response, () => {});
  await mocks.handlers[key][method](request, res as unknown as Response);
  return res;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockReturnValue({ select: () => ({ lean: async () => ({ isAdmin: false, tags: ['old'] }) }) });
  mocks.update.mockResolvedValue({ matchedCount: 1 });
  mocks.audit.mockResolvedValue({});
});
describe('notes and tags route boundaries', () => {
  it('declares first-party JWT-only authentication', () => {
    expect(mocks.options['GET,POST,PATCH']).toMatchObject({ auth: 'jwtOnly' });
    expect(mocks.options.PATCH).toMatchObject({ auth: 'jwtOnly' });
  });
  it.each(['GET', 'POST', 'PATCH'])('denies ordinary users on notes %s', async method => {
    await expect(call('GET,POST,PATCH', method, {}, [])).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });
  it('denies tag writes by support-only delegates', async () => {
    await expect(call('PATCH', 'PATCH', { before: [], tags: [] }, ['support:read'])).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('writes tags with an exact before condition and an attributed audit action', async () => {
    const res = await call('PATCH', 'PATCH', { before: ['old'], tags: ['pilot'] }, ['settings:manage']);
    expect(res._getJSONData()).toEqual({ tags: ['pilot'] });
    expect(mocks.update).toHaveBeenCalledWith(
      { _id: USER, tags: ['old'] },
      { $set: { tags: ['pilot'] } },
      { runValidators: true }
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.tags.updated',
        changes: [{ field: 'tags', before: ['old'], after: ['pilot'] }],
      })
    );
  });
  it('rejects a stale tag snapshot without an audit success', async () => {
    mocks.update.mockResolvedValue({ matchedCount: 0 });
    await expect(call('PATCH', 'PATCH', { before: ['old'], tags: [] }, ['settings:manage'])).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('preserves legacy tags verbatim in the concurrency condition and audit', async () => {
    const before = [' vip ', 'pilot', 'PILOT', 'x'.repeat(65), ...Array.from({ length: 101 }, (_, i) => `tag${i}`)];
    await call('PATCH', 'PATCH', { before, tags: ['vip'] }, ['settings:manage']);
    expect(mocks.update).toHaveBeenCalledWith(
      { _id: USER, tags: before },
      { $set: { tags: ['vip'] } },
      { runValidators: true }
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'tags', before, after: ['vip'] }] })
    );
  });
  it('rejects unbounded and duplicate tags before writing', async () => {
    for (const tags of [['x'.repeat(65)], Array.from({ length: 101 }, (_, i) => `tag${i}`), ['pilot', 'PILOT']]) {
      await expect(call('PATCH', 'PATCH', { before: [], tags }, ['settings:manage'])).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('protects admin targets from delegated tag changes', async () => {
    mocks.findById.mockReturnValue({ select: () => ({ lean: async () => ({ adminPermissions: ['support:read'] }) }) });
    await expect(call('PATCH', 'PATCH', { before: [], tags: ['pilot'] }, ['settings:manage'])).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([
    PENDING_FREE_CREDITS_TAG,
    ...RESERVED_PARTNER_RULE_TAGS,
    ...allKnownEntitlementKeys(),
    'datalake:synthetic-lake',
    ...allKnownEntitlementKeys().flatMap(key => {
      const tag = grantTagForEntitlement(key);
      return tag ? [tag] : [];
    }),
  ])('refuses managed tag grants through the free-form endpoint: %s', async tag => {
    await expect(call('PATCH', 'PATCH', { before: [], tags: [tag] }, ['settings:manage'])).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('refuses managed tag removal even when the caller forges the before snapshot', async () => {
    mocks.findById.mockReturnValue({ select: () => ({ lean: async () => ({ tags: ['Developer'] }) }) });
    await expect(call('PATCH', 'PATCH', { before: [], tags: ['pilot'] }, ['settings:manage'])).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([' Developer ', 'DEVELOPER', '  datalake:synthetic-lake  '])(
    'preserves the exact stored managed token while editing free-form tags: %s',
    async managedTag => {
      const before = [managedTag, 'old'];
      mocks.findById.mockReturnValue({ select: () => ({ lean: async () => ({ tags: before }) }) });
      const res = await call('PATCH', 'PATCH', { before, tags: [managedTag, 'pilot'] }, ['settings:manage']);
      const savedTags = [managedTag, 'pilot'];
      expect(res._getJSONData()).toEqual({ tags: savedTags });
      expect(hasDeveloperUserTag(savedTags)).toBe(hasDeveloperUserTag(before));
      expect(mocks.update).toHaveBeenCalledWith(
        { _id: USER, tags: before },
        { $set: { tags: savedTags } },
        { runValidators: true }
      );
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ changes: [{ field: 'tags', before, after: savedTags }] })
      );
    }
  );
  it('preserves managed tags while updating free-form tags', async () => {
    mocks.findById.mockReturnValue({ select: () => ({ lean: async () => ({ tags: ['Developer', 'old'] }) }) });
    const res = await call('PATCH', 'PATCH', { before: ['Developer', 'old'], tags: ['Developer', 'pilot'] }, [
      'settings:manage',
    ]);
    expect(res._getJSONData()).toEqual({ tags: ['Developer', 'pilot'] });
  });
});
