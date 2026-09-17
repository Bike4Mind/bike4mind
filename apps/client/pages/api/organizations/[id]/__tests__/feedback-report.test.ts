import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/organizations/[id]/feedback-report. What is pinned here is the route's contract, not the
 * counting: the owner/manager gate and its deliberately non-enumerating 404, the date-window
 * validation, and that the member population the gate's repository hands back is what reaches the
 * aggregate unchanged - including the ACL/stamp discrepancy lists, which are the whole reason the
 * report is auditable.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: any, _res: any, next: () => void) => next(),
}));

const verifyOrgAccess = vi.hoisted(() => vi.fn(async () => ({ id: 'org1' })));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess }));

const MEMBERS = { userIds: ['u1', 'u2'], aclOnly: ['u1'], stampOnly: ['u2'] };
const findMemberUserIds = vi.hoisted(() =>
  vi.fn(async () => ({ userIds: ['u1', 'u2'], aclOnly: ['u1'], stampOnly: ['u2'] }))
);
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findMemberUserIds } }));

const orgFeedbackReport = vi.hoisted(() => vi.fn(async () => ({ totals: { count: 7 } })));
vi.mock('@bike4mind/database', () => ({ orgFeedbackReport }));

import '../feedback-report';

const invoke = async (query: Record<string, string>, user: unknown = { id: 'owner1', isAdmin: false }) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'org1', ...query } });
  (req as any).user = user;
  await mockRefs.getHandler!(req, res);
  return res;
};

describe('GET /api/organizations/[id]/feedback-report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyOrgAccess.mockResolvedValue({ id: 'org1' } as never);
    findMemberUserIds.mockResolvedValue(MEMBERS as never);
    orgFeedbackReport.mockResolvedValue({ totals: { count: 7 } } as never);
  });

  it('answers a non-enumerating 404 and reads nothing when the caller is not an owner', async () => {
    const notFound = Object.assign(new Error('Organization not found'), { statusCode: 404 });
    verifyOrgAccess.mockRejectedValue(notFound as never);

    await expect(invoke({})).rejects.toThrow('Organization not found');
    expect(findMemberUserIds).not.toHaveBeenCalled();
    expect(orgFeedbackReport).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before touching the org', async () => {
    await expect(invoke({}, null)).rejects.toThrow('Authentication required');
    expect(verifyOrgAccess).not.toHaveBeenCalled();
  });

  it('rejects an unparseable date with a validation error, not a 500 from a cast', async () => {
    await expect(invoke({ from: 'not-a-date' })).rejects.toThrow(/parseable date/i);
    expect(orgFeedbackReport).not.toHaveBeenCalled();
  });

  it('rejects an inverted range', async () => {
    await expect(invoke({ from: '2026-03-01', to: '2026-02-01' })).rejects.toThrow(/from must not be after to/);
    expect(orgFeedbackReport).not.toHaveBeenCalled();
  });

  it('hands the aggregate the population the repository returned, discrepancy lists included', async () => {
    const res = await invoke({ from: '2026-01-05', to: '2026-01-06', subject: 'session' });

    expect(findMemberUserIds).toHaveBeenCalledWith('org1');
    const args = orgFeedbackReport.mock.calls[0][0] as any;
    expect(args.members).toEqual(MEMBERS);
    expect(args.organizationId).toBe('org1');
    expect(args.subject).toBe('session');
    // Rounded to whole local days, so a same-day from/to still spans that day.
    expect(args.from.getTime()).toBeLessThan(args.to.getTime());
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ totals: { count: 7 } });
  });

  it('defaults to a trailing window when no dates are given', async () => {
    await invoke({});

    const args = orgFeedbackReport.mock.calls[0][0] as any;
    const spanDays = (args.to.getTime() - args.from.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThan(29);
    expect(spanDays).toBeLessThan(32);
    expect(args.subject).toBeUndefined();
  });
});
