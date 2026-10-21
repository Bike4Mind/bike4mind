import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

// Captures the config so a test can assert requiredScopes: the scope gate lives in
// apiKeyAuth (real middleware, not exercised here), so asserting the handler is
// registered with it is the only guard available at this level.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: (...a: unknown[]) => mockAddCredits(...a) },
}));

let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(undefined);
    } finally {
      inTransaction = false;
    }
  },
}));

vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
// parseAdminActionReason stays real so the reason 400s come from the route itself.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn(async () => {
    insideTransactionAtAudit = inTransaction;
    return null;
  }),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import handler from '../top-up';

const BODY = { credits: 100, idempotencyKey: 'idem-key-12345', reason: 'Support goodwill top-up' };

function call(options: { isAdmin?: boolean; body?: object; id?: string }) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: options.id ?? 'org-1' },
    body: options.body ?? BODY,
  });
  (req as unknown as { user: { isAdmin: boolean; id: string; username: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
    username: 'admin',
  };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/admin/organizations/[id]/top-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindById.mockResolvedValue({ id: 'org-1', userId: 'owner-1' });
    mockAddCredits.mockResolvedValue(undefined);
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    // Pins the whole config object, not just requiredScopes - a sibling `auth: false`
    // would skip baseApi's entire api-key chain (baseApi.ts's `if (resolvedOptions.auth)`)
    // and disable this gate while leaving requiredScopes untouched.
    const config = (handler as unknown as { _config?: unknown })._config;
    expect(config).toEqual({ requiredScopes: [ApiKeyScope.ADMIN] });
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('grants credits to the organization for an admin', async () => {
    const { res, run } = call({});
    await run();
    expect(mockAddCredits).toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ organizationId: 'org-1', creditsAdded: 100 });
  });

  it('records org.credits.topped_up against the organization, inside the transaction', async () => {
    const { run } = call({});
    await run();
    expect(insideTransactionAtAudit).toBe(true);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.credits.topped_up',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
        reason: 'Support goodwill top-up',
      })
    );
  });

  it('fails the request when the strict audit write fails, so the transaction rolls back', async () => {
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('audit down'));
    const { res, run } = call({});
    await expect(run()).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['under five characters', ' abc '],
    ['over 500 characters', 'x'.repeat(501)],
  ])('answers 400 and adds no credits when the reason is %s', async (_label, reason) => {
    const { run } = call({ body: { ...BODY, reason } });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
