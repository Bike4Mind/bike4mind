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

const mockOrgCreate = vi.fn();
const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  organizationService: { create: (...a: unknown[]) => mockOrgCreate(...a) },
  creditService: { addCreditsWithLedgerRow: (...a: unknown[]) => mockAddCredits(...a) },
}));

let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
const mockUserFindByEmail = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: { findByEmail: (...a: unknown[]) => mockUserFindByEmail(...a) },
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(undefined);
    } finally {
      inTransaction = false;
    }
  },
}));

const mockSubCreate = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { create: (...a: unknown[]) => mockSubCreate(...a) },
}));

// Admin-configurable team-plan knobs, pinned to their defaults (see packages/server-utils/src/services/teamPlanSettings).
vi.mock('@bike4mind/server-utils/services/teamPlanSettings', () => ({
  getTeamPlanSettings: vi.fn(async () => ({ minSeats: 4, maxSeats: 100, creditsPerSeat: 50000 })),
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
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
import handler from '../grant';

const BODY = {
  name: 'Acme Corp',
  ownerEmail: 'owner@example.com',
  seats: 5,
  initialCredits: 1000,
  reason: 'Sales-approved pilot',
};

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
    mockAddCredits.mockResolvedValue({ creditHolder: {}, creditTransactionId: 'tx-grant' });
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

  it('records org.credits.granted against the new organization', async () => {
    const { run } = call({});
    await run();
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(insideTransactionAtAudit).toBe(true);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.credits.granted',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1', displayName: 'Acme Corp' }),
        reason: 'Sales-approved pilot',
        related: { creditTransactionId: 'tx-grant' },
      })
    );
  });

  it('records no related ledger link when there are no initial credits', async () => {
    const { run } = call({ body: { ...BODY, initialCredits: 0 } });
    await run();
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ related: undefined })
    );
  });

  it.each([
    ['missing', undefined],
    ['under five characters', ' abc '],
    ['over 500 characters', 'x'.repeat(501)],
  ])('answers 400 and creates nothing when the reason is %s', async (_label, reason) => {
    const { run } = call({ body: { ...BODY, reason } });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockOrgCreate).not.toHaveBeenCalled();
    expect(mockSubCreate).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('records the initial credits as details.credits alongside the existing details', async () => {
    const { run } = call({});
    await run();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ ownerId: 'owner-1', seats: 5, initialCredits: 1000, credits: 1000 }),
      })
    );
  });
});
