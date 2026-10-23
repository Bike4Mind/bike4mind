import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { ADMIN, ALL_ACTIONS, USER_ID, makeUser } from '@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks';

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).baseApiMock()
);
vi.mock('@server/middlewares/asyncHandler', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).asyncHandlerMock()
);
vi.mock('@bike4mind/database', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).databaseMock()
);
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));

const mockResolve = vi.fn();
const mockCounts = vi.fn();
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    abuseService: {
      ...actual.abuseService,
      resolveBulkAbuseCohort: (...a: unknown[]) => mockResolve(...a),
      previewBulkAbuseCounts: (...a: unknown[]) => mockCounts(...a),
    },
  };
});

vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn(async () => null),
  denySelfAdminAction: vi.fn(async () => {
    throw Object.assign(new Error('self'), { statusCode: 403 });
  }),
}));

import { abuseService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { verifyBulkAbusePreviewToken } from '@server/admin/bulkAbuse/previewToken';
import handler from '../bulk-preview';

async function call(body: Record<string, unknown>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as { user: unknown }).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/admin/abuse/bulk-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue({
      included: [makeUser(USER_ID)],
      excluded: [{ userId: 'd'.repeat(24), email: 'paid@kashre.com', reason: 'paid' }],
      hasMore: true,
      nextAfterUserId: USER_ID,
    });
    mockCounts.mockResolvedValue({ sample: [], alreadyBannedCount: 0, activeApiKeyCount: 2, clawbackCredits: 100 });
  });

  it('requires the admin API key scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({ requiredScopes: [ApiKeyScope.ADMIN] });
  });

  it('refuses a non-admin', async () => {
    await expect(
      call({ target: { kind: 'domain', domain: 'kashre.com' }, actions: ALL_ACTIONS }, { ...ADMIN, isAdmin: false })
    ).rejects.toThrow('Admin access required');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('returns counts, exclusions and a token bound to this admin and cohort', async () => {
    const target = { kind: 'domain', domain: '*.Kashre.com' } as const;
    const res = await call({ target, actions: ALL_ACTIONS });

    const body = res._getJSONData();
    expect(body).toMatchObject({
      includedCount: 1,
      activeApiKeyCount: 2,
      clawbackCredits: 100,
      blocksDomain: 'kashre.com',
      hasMore: true,
      nextAfterUserId: USER_ID,
      excluded: [expect.objectContaining({ reason: 'paid' })],
    });
    expect(verifyBulkAbusePreviewToken(body.previewToken)).toEqual({
      adminId: ADMIN.id,
      fingerprint: abuseService.bulkAbuseFingerprint(target, ALL_ACTIONS, [USER_ID]),
    });
    expect(mockResolve).toHaveBeenCalledWith(target, ADMIN.id, expect.anything());
  });

  it('does not offer a domain block without the ban action', async () => {
    const res = await call({
      target: { kind: 'domain', domain: 'kashre.com' },
      actions: { ...ALL_ACTIONS, ban: false },
    });
    expect(res._getJSONData().blocksDomain).toBeNull();
  });

  it('writes no audit entry', async () => {
    await call({ target: { kind: 'users', userIds: [USER_ID] }, actions: ALL_ACTIONS });
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it("denies a target that names the admin's own account", async () => {
    await expect(call({ target: { kind: 'users', userIds: [ADMIN.id] }, actions: ALL_ACTIONS })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('refuses a request with no action selected', async () => {
    const none = { ban: false, revokeApiKeys: false, revokeSessions: false, clawbackFreeCredits: false };
    await expect(call({ target: { kind: 'users', userIds: [USER_ID] }, actions: none })).rejects.toThrow();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
