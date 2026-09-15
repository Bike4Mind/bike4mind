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

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: (...a: unknown[]) => mockAddCredits(...a) },
}));

const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));

vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_TOPPED_UP: 'org_topped_up' },
  logAuditEvent: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import handler from '../top-up';

function call(options: { isAdmin?: boolean; body?: object; id?: string }) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: options.id ?? 'org-1' },
    body: options.body ?? { credits: 100, idempotencyKey: 'idem-key-12345' },
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
});
