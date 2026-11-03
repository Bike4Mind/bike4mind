import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { ADMIN, ALL_ACTIONS, OTHER_ID, USER_ID, makeUser } from '@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks';

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
const mockExecute = vi.fn();
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    abuseService: {
      ...actual.abuseService,
      resolveBulkAbuseCohort: (...a: unknown[]) => mockResolve(...a),
      executeBulkAbuse: (...a: unknown[]) => mockExecute(...a),
    },
  };
});

const mockAddBlockedDomain = vi.fn(async () => true);
vi.mock('@server/admin/bulkAbuse/addBlockedEmailDomain', () => ({
  addBlockedEmailDomain: (...a: unknown[]) => mockAddBlockedDomain(...a),
}));

// parseAdminActionReason and isSelfOrImpersonator stay real.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn(async () => null),
  denySelfAdminAction: vi.fn(async () => {
    throw Object.assign(new Error('self'), { statusCode: 403 });
  }),
}));

import { abuseService } from '@bike4mind/services';
import { denySelfAdminAction, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { signBulkAbusePreviewToken } from '@server/admin/bulkAbuse/previewToken';
import handler from '../bulk-execute';

const USERS_TARGET = { kind: 'users', userIds: [USER_ID] } as const;
const REASON = 'Burner-domain credit farming cohort';
const BOUND = '6a00000000000000ffffffff';
const fingerprintFor = (target: Parameters<typeof abuseService.bulkAbuseFingerprint>[0], ids: string[]) =>
  abuseService.bulkAbuseFingerprint(target, ALL_ACTIONS, ids);

function succeeded(userId: string) {
  return {
    userId,
    email: null,
    status: 'succeeded',
    steps: { ban: 'applied', revokeApiKeys: 'applied', revokeSessions: 'applied', clawbackFreeCredits: 'applied' },
    revokedApiKeys: 1,
    clawedBackCredits: 50,
  };
}

const mockLoggerError = vi.fn();

async function call(body: Record<string, unknown>, user: Record<string, unknown> = ADMIN, canEditSettings = true) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user, ability: { can: () => canEditSettings }, logger: { error: mockLoggerError } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  target: USERS_TARGET,
  actions: ALL_ACTIONS,
  reason: REASON,
  previewToken: signBulkAbusePreviewToken(ADMIN.id, fingerprintFor(USERS_TARGET, [USER_ID]), null),
  ...overrides,
});

describe('POST /api/admin/abuse/bulk-execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue({
      included: [makeUser(USER_ID)],
      excluded: [],
      hasMore: false,
      nextAfterUserId: null,
    });
    mockExecute.mockResolvedValue([succeeded(USER_ID)]);
  });

  it('requires JWT authentication with admin scope metadata', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin', async () => {
    await expect(call(validBody(), { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('executes a matching preview and records a summary entry', async () => {
    const res = await call(validBody());

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      succeededCount: 1,
      failedCount: 0,
      bannedCount: 1,
      clawedBackCredits: 50,
    });
    expect(mockExecute).toHaveBeenCalledWith([makeUser(USER_ID)], ALL_ACTIONS, ADMIN.id, expect.anything());
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'abuse.bulk.executed', reason: REASON })
    );
    expect(mockAddBlockedDomain).not.toHaveBeenCalled();
  });

  it('still returns the applied result when the summary audit write fails', async () => {
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('audit down'));
    const res = await call(validBody());

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ succeededCount: 1, failedCount: 0 });
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[ADMIN_AUDIT_WRITE_FAILED]',
      expect.objectContaining({ action: 'abuse.bulk.executed' })
    );
  });

  it('refuses when the cohort changed since the preview', async () => {
    mockResolve.mockResolvedValue({
      included: [makeUser(USER_ID), makeUser(OTHER_ID)],
      excluded: [],
      hasMore: false,
      nextAfterUserId: null,
    });
    await expect(call(validBody())).rejects.toMatchObject({ statusCode: 409 });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('refuses a token minted for different actions', async () => {
    const token = signBulkAbusePreviewToken(
      ADMIN.id,
      abuseService.bulkAbuseFingerprint(USERS_TARGET, { ...ALL_ACTIONS, ban: false }, [USER_ID]),
      null
    );
    await expect(call(validBody({ previewToken: token }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses another admin's or a forged token", async () => {
    const othersToken = signBulkAbusePreviewToken(OTHER_ID, fingerprintFor(USERS_TARGET, [USER_ID]), null);
    await expect(call(validBody({ previewToken: othersToken }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(call(validBody({ previewToken: 'not-a-token' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('requires a reason', async () => {
    await expect(call(validBody({ reason: '' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("denies and audits a target that names the admin's own account", async () => {
    const target = { kind: 'users', userIds: [USER_ID, ADMIN.id] };
    await expect(call(validBody({ target }))).rejects.toMatchObject({ statusCode: 403 });
    expect(denySelfAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'abuse.bulk.denied', target: expect.objectContaining({ id: ADMIN.id }) })
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('adds the domain to the blocklist before actioning users on a domain ban', async () => {
    const target = { kind: 'domain', domain: '@Kashre.com' } as const;
    const order: string[] = [];
    mockAddBlockedDomain.mockImplementation(async () => (order.push('block'), true));
    mockExecute.mockImplementation(async () => (order.push('execute'), [succeeded(USER_ID)]));

    const res = await call(
      validBody({ target, previewToken: signBulkAbusePreviewToken(ADMIN.id, fingerprintFor(target, [USER_ID]), BOUND) })
    );

    expect(mockAddBlockedDomain).toHaveBeenCalledWith(expect.anything(), 'kashre.com');
    expect(order).toEqual(['block', 'execute']);
    // Re-resolved against the preview's bound, so accounts created since the preview do not 409 it.
    expect(mockResolve).toHaveBeenCalledWith(target, ADMIN.id, expect.anything(), { upToUserId: BOUND });
    expect(res._getJSONData()).toMatchObject({ blockedDomain: 'kashre.com' });
  });

  it('does not report an existing domain block as newly added', async () => {
    const target = { kind: 'domain', domain: 'kashre.com' } as const;
    mockAddBlockedDomain.mockResolvedValueOnce(false);

    const res = await call(
      validBody({ target, previewToken: signBulkAbusePreviewToken(ADMIN.id, fingerprintFor(target, [USER_ID]), BOUND) })
    );

    expect(mockExecute).toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ blockedDomain: null, succeededCount: 1 });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: expect.objectContaining({ displayName: 'kashre.com' }),
        details: expect.objectContaining({ blockedDomain: null }),
      })
    );
  });

  it('refuses before actioning any user when the domain block fails', async () => {
    const target = { kind: 'domain', domain: 'kashre.com' } as const;
    mockAddBlockedDomain.mockRejectedValueOnce(new Error('tx'));

    await expect(
      call(
        validBody({
          target,
          previewToken: signBulkAbusePreviewToken(ADMIN.id, fingerprintFor(target, [USER_ID]), BOUND),
        })
      )
    ).rejects.toThrow('tx');

    expect(mockExecute).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it.each(['github.io', 'co.uk', 'gmail.com', 'outlook.com', 'fastmail.com'])(
    'refuses %s as a domain target',
    async domain => {
      const target = { kind: 'domain', domain };
      await expect(call(validBody({ target }))).rejects.toMatchObject({ statusCode: 400 });
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockAddBlockedDomain).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    }
  );

  it('does not touch the blocklist for a domain target without the ban action', async () => {
    const target = { kind: 'domain', domain: 'kashre.com' } as const;
    const actions = { ...ALL_ACTIONS, ban: false };
    await call({
      target,
      actions,
      reason: REASON,
      previewToken: signBulkAbusePreviewToken(
        ADMIN.id,
        abuseService.bulkAbuseFingerprint(target, actions, [USER_ID]),
        BOUND
      ),
    });
    expect(mockAddBlockedDomain).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalled();
  });

  it('reports partial failure per user', async () => {
    mockResolve.mockResolvedValue({
      included: [makeUser(USER_ID), makeUser(OTHER_ID)],
      excluded: [],
      hasMore: false,
      nextAfterUserId: null,
    });
    mockExecute.mockResolvedValue([succeeded(USER_ID), { ...succeeded(OTHER_ID), status: 'failed', error: 'boom' }]);
    const target = { kind: 'users', userIds: [USER_ID, OTHER_ID] } as const;

    const res = await call(
      validBody({
        target,
        previewToken: signBulkAbusePreviewToken(ADMIN.id, fingerprintFor(target, [USER_ID, OTHER_ID]), null),
      })
    );

    expect(res._getJSONData()).toMatchObject({ succeededCount: 1, failedCount: 1 });
    // The failed user's own entries rolled back, so the summary is where the failure is recorded.
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'abuse.bulk.executed',
        details: expect.objectContaining({ failed: [{ userId: OTHER_ID, error: 'boom' }] }),
      })
    );
  });

  it('refuses a domain ban from an admin who cannot edit admin settings', async () => {
    const target = { kind: 'domain', domain: 'kashre.com' } as const;
    const body = validBody({
      target,
      previewToken: signBulkAbusePreviewToken(ADMIN.id, fingerprintFor(target, [USER_ID]), BOUND),
    });

    await expect(call(body, ADMIN, false)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAddBlockedDomain).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
