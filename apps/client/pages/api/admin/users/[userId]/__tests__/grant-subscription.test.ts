import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
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
const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  organizationService: { create: (...a: unknown[]) => mockOrgCreate(...a) },
  creditService: { addCredits: (...a: unknown[]) => mockAddCredits(...a) },
}));

const mockUserFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));

const mockSubCreate = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    create: (...a: unknown[]) => mockSubCreate(...a),
    findByPriceIdAndOwner: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@server/services/teamPlanSettings', () => ({
  getTeamPlanSettings: vi.fn(async () => ({ minSeats: 3, maxSeats: 8, creditsPerSeat: 1000 })),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_GRANTED: 'org_granted' },
  logAuditEvent: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import handler from '../grant-subscription';

function call(seats: number) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { userId: 'user-1' },
    body: { subscriptionType: 'team', organizationName: 'Acme', seats },
  });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = { isAdmin: true, id: 'admin-1' };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/admin/users/[userId]/grant-subscription - team seat bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mockOrgCreate.mockResolvedValue({ id: 'org-1', name: 'Acme' });
    mockSubCreate.mockResolvedValue({ id: 'sub-1' });
  });

  it('grants a team within the configured range at the configured credits per seat', async () => {
    const { res, run } = call(5);
    await run();
    expect(mockOrgCreate).toHaveBeenCalled();
    expect(mockAddCredits).toHaveBeenCalledWith(expect.objectContaining({ credits: 5 * 1000 }), expect.anything());
    expect(res._getJSONData()).toMatchObject({ seats: 5, credits: 5 * 1000 });
  });

  it.each([
    ['above the configured ceiling', 9, /Seats cannot exceed 8/],
    ['below the configured floor', 2, /at least 3 seats/],
  ])('rejects a seat count %s before creating anything', async (_label, seats, message) => {
    const { run } = call(seats);
    await expect(run()).rejects.toThrow(message);
    expect(mockOrgCreate).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('rejects a fractional seat count', async () => {
    const { run } = call(4.5);
    await expect(run()).rejects.toThrow();
    expect(mockOrgCreate).not.toHaveBeenCalled();
  });
});
