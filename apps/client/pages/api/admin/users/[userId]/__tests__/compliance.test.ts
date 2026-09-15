import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CURRENT_POLICY_VERSION } from '@bike4mind/common';

const { mockUserFind, mockIncidents, mockAuth } = vi.hoisted(() => ({
  mockUserFind: vi.fn(),
  mockIncidents: vi.fn(),
  mockAuth: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
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

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
  imageModerationIncidentRepository: { find: (...a: unknown[]) => mockIncidents(...a) },
  userAuthAuditLogRepository: { findByUser: (...a: unknown[]) => mockAuth(...a) },
}));

import handler from '../compliance';

const run = ({ user, userId = 'u1' }: { user?: unknown; userId?: string } = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockUserFind.mockReset().mockResolvedValue({
    id: 'u1',
    aupAcceptedVersion: null,
    aupAcceptedAt: null,
    ageAttestedAdult: null,
    isBanned: false,
    isModerated: false,
    disputePending: false,
  });
  mockIncidents.mockReset().mockResolvedValue([]);
  mockAuth.mockReset().mockResolvedValue([]);
});

describe('GET /api/admin/users/:userId/compliance', () => {
  it('rejects non-admins and short-circuits before ANY data source', async () => {
    const { promise } = run({ user: { id: 'u2', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockIncidents).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (no req.user)', async () => {
    const { promise } = run(); // no user attached
    await expect(promise).rejects.toThrow();
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('returns "never accepted" (isCurrent false) for a user who never accepted the AUP', async () => {
    const { res, promise } = run({ user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.isCurrent).toBe(false);
    expect(body.aupAcceptedVersion).toBeNull();
    expect(body.currentPolicyVersion).toBe(CURRENT_POLICY_VERSION);
    expect(body.flags).toEqual({ isBanned: false, isModerated: false, disputePending: false });
    expect(mockIncidents).toHaveBeenCalledWith({ userId: 'u1' }, { sort: { createdAt: -1 }, limit: 50 });
    expect(mockAuth).toHaveBeenCalledWith('u1', 50);
  });

  it('returns isCurrent true when the user accepted the in-force AUP version', async () => {
    mockUserFind.mockResolvedValue({
      id: 'u1',
      aupAcceptedVersion: CURRENT_POLICY_VERSION,
      aupAcceptedAt: new Date('2026-06-01'),
      ageAttestedAdult: true,
      isBanned: false,
      isModerated: false,
      disputePending: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    expect(body.isCurrent).toBe(true);
    expect(body.aupAcceptedVersion).toBe(CURRENT_POLICY_VERSION);
    expect(body.ageAttestedAdult).toBe(true);
    // dates are serialized to ISO strings on the wire
    expect(typeof body.aupAcceptedAt).toBe('string');
  });

  it('returns isCurrent false when the accepted AUP version is stale (e.g. grandfathered)', async () => {
    mockUserFind.mockResolvedValue({
      id: 'u1',
      aupAcceptedVersion: 'grandfathered',
      aupAcceptedAt: new Date('2025-01-01'),
      ageAttestedAdult: true,
      isBanned: false,
      isModerated: false,
      disputePending: false,
    });
    const { res, promise } = run({ user: ADMIN });
    await promise;
    const body = res._getJSONData();
    expect(body.aupAcceptedVersion).toBe('grandfathered');
    expect(body.isCurrent).toBe(false);
  });

  it('rejects with "User not found" and hits no data sources when the user is absent', async () => {
    mockUserFind.mockResolvedValue(null);
    const { promise } = run({ user: ADMIN });
    await expect(promise).rejects.toThrow();
    expect(mockIncidents).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });
});
