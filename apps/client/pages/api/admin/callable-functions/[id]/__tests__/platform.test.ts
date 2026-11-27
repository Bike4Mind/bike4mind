import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, ConflictError, NotFoundError, missingAdminPermissionMessage } from '@bike4mind/common';

const FUNCTION_ID = '6b0000000000000000000001';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  setPlatformMark: vi.fn(),
  clearPlatformMark: vi.fn(),
  setPlatformAudience: vi.fn(),
  dropUncovered: vi.fn(),
  record: vi.fn(),
  inTransaction: [] as boolean[],
  txActive: false,
}));

vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => {
    h.inTransaction.push(h.txActive);
    return h.record(...args);
  },
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
}));

vi.mock('@bike4mind/server-utils/callableFunctions/sharing', () => ({
  dropUncoveredCallableFunctionReviews: h.dropUncovered,
}));

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/admin/bulkAbuse/__tests__/bulkAbuseRouteMocks')).adminApiMock()
);

vi.mock('@bike4mind/database', () => ({
  mongoose: { isObjectIdOrHexString: (id: string) => /^[0-9a-f]{24}$/.test(id) },
  callableFunctionRepository: {
    findById: h.findById,
    setPlatformMark: h.setPlatformMark,
    clearPlatformMark: h.clearPlatformMark,
    setPlatformAudience: h.setPlatformAudience,
  },
  withTransaction: async (fn: () => Promise<unknown>) => {
    h.txActive = true;
    try {
      return await fn();
    } finally {
      h.txActive = false;
    }
  },
}));

import handler from '../platform';

const ADMIN = { id: 'admin1', isAdmin: true };

const liveFn = (overrides: Record<string, unknown> = {}) => ({
  id: FUNCTION_ID,
  userId: 'owner1',
  slug: 'beam_deflection',
  state: 'live',
  trustLabel: 'verified',
  ...overrides,
});

const run = (method: 'POST' | 'PATCH' | 'DELETE', user: unknown = ADMIN, id = FUNCTION_ID, body: unknown = {}) => {
  const { req, res } = createMocks({ method, query: { id }, body: body as Record<string, unknown> });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  h.findById.mockReset().mockResolvedValue(liveFn());
  h.setPlatformMark
    .mockReset()
    .mockImplementation(async (_id: string, mark: { setBy: string; setAt: Date }) => liveFn({ platform: mark }));
  h.clearPlatformMark.mockReset().mockResolvedValue(liveFn());
  h.setPlatformAudience
    .mockReset()
    .mockImplementation(async (_id: string, audience: string | null) =>
      liveFn({ platform: { setBy: 'admin0', setAt: new Date(), ...(audience ? { audience } : {}) } })
    );
  h.dropUncovered.mockReset().mockResolvedValue(undefined);
  h.record.mockReset().mockResolvedValue(undefined);
  h.inTransaction.length = 0;
});

describe('/api/admin/callable-functions/:id/platform', () => {
  it('is JWT-only and needs models:curate and the admin scope', async () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { POST: 'models:curate', PATCH: 'models:curate', DELETE: 'models:curate' },
    });
    const delegate = { id: 'u1', isAdmin: false, adminPermissions: ['support:read'] };
    await expect(run('POST', delegate).promise).rejects.toThrow(missingAdminPermissionMessage('models:curate'));
    await expect(run('DELETE', delegate).promise).rejects.toThrow(missingAdminPermissionMessage('models:curate'));
    await expect(run('PATCH', delegate, FUNCTION_ID, { audience: 'signed_in' }).promise).rejects.toThrow(
      missingAdminPermissionMessage('models:curate')
    );
    expect(h.setPlatformMark).not.toHaveBeenCalled();
    expect(h.clearPlatformMark).not.toHaveBeenCalled();
    expect(h.setPlatformAudience).not.toHaveBeenCalled();
  });

  it('marks a verified function, recording the admin on it and in the audit log', async () => {
    const { res, promise } = run('POST', ADMIN, FUNCTION_ID, { reason: 'Checked against the handbook' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      id: FUNCTION_ID,
      trustLabel: 'platform',
      platform: { setBy: 'admin1' },
    });
    expect(h.setPlatformMark).toHaveBeenCalledWith(FUNCTION_ID, { setBy: 'admin1', setAt: expect.any(Date) });
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'callable_function.platform.marked',
        target: { kind: 'user', id: 'owner1', displayName: 'owner1' },
        details: { functionId: FUNCTION_ID, slug: 'beam_deflection' },
        reason: 'Checked against the handbook',
      })
    );
    expect(h.inTransaction).toEqual([true]);
  });

  it('refuses a function that is not verified at that moment, and audits nothing', async () => {
    h.findById.mockResolvedValue(liveFn({ trustLabel: 'unverified' }));
    h.setPlatformMark.mockResolvedValue(null);
    await expect(run('POST').promise).rejects.toBeInstanceOf(ConflictError);
    expect(h.record).not.toHaveBeenCalled();
  });

  it('answers not found for a missing function or an id that is not one', async () => {
    h.findById.mockResolvedValue(null);
    await expect(run('POST').promise).rejects.toBeInstanceOf(NotFoundError);
    await expect(run('POST', ADMIN, 'not-an-id').promise).rejects.toBeInstanceOf(NotFoundError);
    expect(h.setPlatformMark).not.toHaveBeenCalled();
  });

  it('clears the mark and audits who cleared it, then drops the reviews it no longer covers', async () => {
    const { res, promise } = run('DELETE');
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ id: FUNCTION_ID, trustLabel: 'verified', platform: null, audience: null });
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'callable_function.platform.cleared' })
    );
    expect(h.dropUncovered).toHaveBeenCalledWith(expect.objectContaining({ id: FUNCTION_ID }));
  });

  it('offers a marked function to everyone signed in, in one audited write, and keeps every review', async () => {
    const { res, promise } = run('PATCH', ADMIN, FUNCTION_ID, { audience: 'signed_in', reason: 'Curated set' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: FUNCTION_ID, trustLabel: 'platform', audience: 'signed_in' });
    expect(h.setPlatformAudience).toHaveBeenCalledWith(FUNCTION_ID, 'signed_in');
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'callable_function.audience.set',
        details: { functionId: FUNCTION_ID, slug: 'beam_deflection', audience: 'signed_in' },
        reason: 'Curated set',
      })
    );
    expect(h.inTransaction).toEqual([true]);
    expect(h.dropUncovered).not.toHaveBeenCalled();
  });

  it('refuses the audience on a function without the label, and audits nothing', async () => {
    h.setPlatformAudience.mockResolvedValue(null);
    await expect(run('PATCH', ADMIN, FUNCTION_ID, { audience: 'signed_in' }).promise).rejects.toMatchObject({
      additionalInfo: { code: 'not_platform' },
    });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('withdraws the audience, audits it, and drops the reviews of the people it no longer reaches', async () => {
    const { res, promise } = run('PATCH', ADMIN, FUNCTION_ID, { audience: null });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ trustLabel: 'platform', audience: null });
    expect(h.setPlatformAudience).toHaveBeenCalledWith(FUNCTION_ID, null);
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'callable_function.audience.cleared' })
    );
    expect(h.dropUncovered).toHaveBeenCalledWith(expect.objectContaining({ id: FUNCTION_ID }));

    h.setPlatformAudience.mockResolvedValue(null);
    await expect(run('PATCH', ADMIN, FUNCTION_ID, { audience: null }).promise).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an audience it does not know and a missing function', async () => {
    const { res, promise } = run('PATCH', ADMIN, FUNCTION_ID, { audience: 'public' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    h.findById.mockResolvedValue(null);
    await expect(run('PATCH', ADMIN, FUNCTION_ID, { audience: 'signed_in' }).promise).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(h.setPlatformAudience).not.toHaveBeenCalled();
  });

  it.each([{ reason: 'x'.repeat(1001) }, { reason: 42 }])('rejects an invalid reason with a 400', async (body) => {
    const { res, promise } = run('POST', ADMIN, FUNCTION_ID, body);
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(h.setPlatformMark).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('fails the request when the audit write fails, on mark and on clear', async () => {
    h.record.mockRejectedValue(new Error('audit down'));
    const marked = run('POST');
    await expect(marked.promise).rejects.toThrow('audit down');
    expect(marked.res._isEndCalled()).toBe(false);
    const cleared = run('DELETE');
    await expect(cleared.promise).rejects.toThrow('audit down');
    expect(cleared.res._isEndCalled()).toBe(false);
  });

  it('answers not found when there is no mark to clear', async () => {
    h.clearPlatformMark.mockResolvedValue(null);
    await expect(run('DELETE').promise).rejects.toBeInstanceOf(NotFoundError);
    expect(h.record).not.toHaveBeenCalled();
  });
});
