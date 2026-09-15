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

const mockOrgCreate = vi.fn();
vi.mock('@bike4mind/services', () => ({
  organizationService: { create: (...a: unknown[]) => mockOrgCreate(...a) },
  creditService: { addCredits: vi.fn() },
}));

const mockUserFindByEmail = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: { findByEmail: (...a: unknown[]) => mockUserFindByEmail(...a) },
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));

const mockSubCreate = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { create: (...a: unknown[]) => mockSubCreate(...a) },
}));

vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_GRANTED: 'org_granted' },
  logAuditEvent: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import handler from '../grant';

const BODY = { name: 'Acme Corp', ownerEmail: 'owner@example.com', seats: 5, initialCredits: 1000, reason: 'sales' };

function call(options: { isAdmin?: boolean; body?: object }) {
  const { req, res } = createMocks({ method: 'POST', body: options.body ?? BODY });
  (req as unknown as { user: { isAdmin: boolean; id: string; username: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
    username: 'admin',
  };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/admin/organizations/grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindByEmail.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
    mockOrgCreate.mockResolvedValue({ id: 'org-1', name: 'Acme Corp' });
    mockSubCreate.mockResolvedValue({ id: 'sub-1' });
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
    expect(mockOrgCreate).not.toHaveBeenCalled();
  });

  it('creates the organization with a subscription for an admin', async () => {
    const { res, run } = call({});
    await run();
    expect(mockOrgCreate).toHaveBeenCalled();
    expect(mockSubCreate).toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ organizationId: 'org-1', name: 'Acme Corp' });
  });
});
