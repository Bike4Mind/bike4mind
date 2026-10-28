import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).baseApiMock()
);
vi.mock('@server/middlewares/asyncHandler', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).asyncHandlerMock()
);
// Recorded at import, so a plain array that clearAllMocks does not reset.
const { rateLimitOptions } = vi.hoisted(() => ({ rateLimitOptions: [] as unknown[] }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => (rateLimitOptions.push(options), () => undefined),
}));
const mockDeps = vi.fn(() => ({ deps: true }));
vi.mock('@server/admin/usersBulk/adapters', () => ({ usersBulkExecuteDeps: (...a: unknown[]) => mockDeps(...a) }));
const mockExecute = vi.fn();
vi.mock('@server/admin/usersBulk/execute', () => ({
  executeAdminUsersBulk: (...a: unknown[]) => mockExecute(...a),
}));

import handler from '../execute';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const BODY = {
  target: { kind: 'ids', userIds: ['b'.repeat(24)] },
  action: { type: 'contain' },
  reason: 'Coordinated abuse from one campaign',
  idempotencyKey: '7b1f3c52-9a3e-4b8e-8f43-2f4a1c9d0e11',
  expectedCount: 1,
  cohortHash: 'c'.repeat(64),
};
const RESULT = {
  batchId: 'x',
  applied: 1,
  skipped: 0,
  failed: [],
  undoExpiresAt: '2026-10-27T00:00:30.000Z',
  blockedDomains: [],
};

const canEditSettings = (allowed: boolean) => ({ can: vi.fn(() => allowed) });

async function call(body: unknown, user: Record<string, unknown> = ADMIN, ability: unknown = canEditSettings(true)) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user, ability, logger: { error: vi.fn() } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/admin/users/bulk/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(RESULT);
  });

  it('requires JWT admin auth and a per-admin rate limit', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
    expect(rateLimitOptions).toContainEqual(expect.objectContaining({ limit: 10, windowMs: 60_000 }));
  });

  it('refuses a non-admin', async () => {
    await expect(call(BODY, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it.each([
    ['a too-short reason', { reason: 'bad' }],
    ['a missing idempotency key', { idempotencyKey: undefined }],
    ['an expectedCount over the cap', { expectedCount: 501 }],
    ['a missing cohort hash', { cohortHash: undefined }],
    ['a malformed cohort hash', { cohortHash: 'C'.repeat(64) }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(call({ ...BODY, ...overrides })).rejects.toThrow();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('executes as the calling admin with their reason', async () => {
    const res = await call(BODY);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(RESULT);
    expect(mockDeps).toHaveBeenCalledWith(expect.anything(), BODY.reason, expect.anything());
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: 'contain' }, expectedCount: 1, cohortHash: BODY.cohortHash }),
      { id: ADMIN.id, selfIds: [ADMIN.id] },
      { deps: true }
    );
  });

  describe('blocking email domains', () => {
    const BLOCKING = { ...BODY, action: { type: 'contain', blockEmailDomains: true } };

    it('refuses with 403 when the admin cannot update admin settings', async () => {
      const ability = canEditSettings(false);
      await expect(call(BLOCKING, ADMIN, ability)).rejects.toMatchObject({ statusCode: 403 });
      expect(ability.can).toHaveBeenCalledWith('update', AdminSettings);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('executes when the admin can update admin settings', async () => {
      const res = await call(BLOCKING, ADMIN, canEditSettings(true));
      expect(res._getStatusCode()).toBe(200);
      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ action: { type: 'contain', blockEmailDomains: true } }),
        expect.anything(),
        expect.anything()
      );
    });

    it('does not ask for that permission when the toggle is off', async () => {
      const ability = canEditSettings(false);
      const res = await call(BODY, ADMIN, ability);
      expect(res._getStatusCode()).toBe(200);
      expect(ability.can).not.toHaveBeenCalled();
    });
  });

  it('propagates a conflict from execute', async () => {
    mockExecute.mockRejectedValueOnce(Object.assign(new Error('The matching users changed'), { statusCode: 409 }));
    await expect(call(BODY)).rejects.toMatchObject({ statusCode: 409 });
  });
});
