import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The drill-down's contract: the same owner/manager gate as the counts, the member population
 * re-read server-side on every request, and one indistinguishable denial for every way a row can
 * be out of reach. What must NOT be here is as load-bearing as what is - no feedback text, no
 * promptMeta - so the shape assertion below is a denial list, not a convenience.
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

// The options each route asks for, because a missing `bucket` is invisible under a mock that
// ignores them: the limiter would key off the raw pathname, so `/organizations/<id>/...` would
// give every org - and for the single-item route every feedback id - its own private budget.
const rateLimitOptions = vi.hoisted(() => [] as { limit: number; windowMs: number; bucket?: string }[]);

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: { limit: number; windowMs: number; bucket?: string }) => {
    rateLimitOptions.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

const verifyOrgAccess = vi.hoisted(() => vi.fn(async () => ({ id: 'org1' })));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess }));

const MEMBERS = { userIds: ['u1', 'u2'], aclOnly: ['u1'], stampOnly: ['u2'] };
const findMemberUserIds = vi.hoisted(() =>
  vi.fn(async () => ({ userIds: [] as string[], aclOnly: [], stampOnly: [] }))
);
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findMemberUserIds } }));

const orgFeedbackItems = vi.hoisted(() => vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })));
const orgFeedbackItem = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('@bike4mind/database', () => ({ orgFeedbackItems, orgFeedbackItem }));

const ITEM = {
  id: '65b000000000000000000001',
  createdAt: '2026-01-10T12:00:00.000Z',
  userId: 'u1',
  username: 'user-u1',
  subject: 'turn',
  status: 'New',
  tags: [],
  contentStored: true,
};

let listHandler: (req: any, res: any) => unknown;
let itemHandler: (req: any, res: any) => unknown;

beforeAll(async () => {
  await import('../items');
  listHandler = mockRefs.getHandler!;
  await import('../[feedbackId]');
  itemHandler = mockRefs.getHandler!;
});

const invoke = async (
  handler: (req: any, res: any) => unknown,
  query: Record<string, string>,
  user: unknown = { id: 'owner1', isAdmin: false }
) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'org1', ...query } });
  (req as any).user = user;
  await handler(req, res);
  return res;
};

const notFound = () => Object.assign(new Error('Organization not found'), { statusCode: 404 });

describe('org feedback report drill-down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyOrgAccess.mockResolvedValue({ id: 'org1' } as never);
    findMemberUserIds.mockResolvedValue(MEMBERS as never);
    orgFeedbackItems.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 } as never);
    orgFeedbackItem.mockResolvedValue(ITEM as never);
  });

  describe('GET .../feedback-report/items', () => {
    it('answers the org gate first and reads nothing when the caller is not an owner', async () => {
      verifyOrgAccess.mockRejectedValue(notFound() as never);

      await expect(invoke(listHandler, {})).rejects.toThrow('Organization not found');
      expect(findMemberUserIds).not.toHaveBeenCalled();
      expect(orgFeedbackItems).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated caller before touching the org', async () => {
      await expect(invoke(listHandler, {}, null)).rejects.toThrow('Authentication required');
      expect(verifyOrgAccess).not.toHaveBeenCalled();
    });

    it('scopes on the population it re-read, not on anything the client sent', async () => {
      const res = await invoke(listHandler, {
        from: '2026-01-05',
        to: '2026-01-06',
        subject: 'session',
        userIds: 'attacker',
      });

      expect(findMemberUserIds).toHaveBeenCalledWith('org1');
      const args = orgFeedbackItems.mock.calls[0][0] as any;
      expect(args.members).toEqual(MEMBERS);
      expect(args.organizationId).toBe('org1');
      expect(args.subject).toBe('session');
      expect(args.from.getTime()).toBeLessThan(args.to.getTime());
      expect(res._getStatusCode()).toBe(200);
    });

    it('clamps an oversized page and a negative offset rather than passing them through', async () => {
      await invoke(listHandler, { limit: '5000', offset: '-10' });

      const args = orgFeedbackItems.mock.calls[0][0] as any;
      expect(args.limit).toBe(100);
      expect(args.offset).toBe(0);
    });

    it('rejects an unparseable date with a validation error, not a 500 from a cast', async () => {
      await expect(invoke(listHandler, { from: 'not-a-date' })).rejects.toThrow(/parseable date/i);
      expect(orgFeedbackItems).not.toHaveBeenCalled();
    });
  });

  describe('GET .../feedback-report/[feedbackId]', () => {
    it('returns metadata only - no verbatim, no promptMeta', async () => {
      const res = await invoke(itemHandler, { feedbackId: ITEM.id });

      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      expect(body).toEqual(ITEM);
      expect(body).not.toHaveProperty('content');
      expect(body).not.toHaveProperty('promptMeta');
    });

    it('denies a row the scoped read cannot see with the same error as a malformed id', async () => {
      orgFeedbackItem.mockResolvedValue(null as never);
      await expect(invoke(itemHandler, { feedbackId: ITEM.id })).rejects.toThrow('Feedback not found');

      await expect(invoke(itemHandler, { feedbackId: 'not-an-object-id' })).rejects.toThrow('Feedback not found');
      // The malformed id never reaches the query - a cast there throws out of the driver as a 500.
      expect(orgFeedbackItem).toHaveBeenCalledTimes(1);
    });

    it('answers the org gate before saying anything about a feedback id', async () => {
      verifyOrgAccess.mockRejectedValue(notFound() as never);

      await expect(invoke(itemHandler, { feedbackId: ITEM.id })).rejects.toThrow('Organization not found');
      expect(findMemberUserIds).not.toHaveBeenCalled();
      expect(orgFeedbackItem).not.toHaveBeenCalled();
    });

    it('hands the query the population it re-read', async () => {
      await invoke(itemHandler, { feedbackId: ITEM.id });

      expect(orgFeedbackItem).toHaveBeenCalledWith({
        organizationId: 'org1',
        feedbackId: ITEM.id,
        members: MEMBERS,
      });
    });
  });
});

describe('rate limiting', () => {
  it('caps by a stable per-route bucket, never by the id in the path', () => {
    expect(rateLimitOptions).toHaveLength(2);
    for (const options of rateLimitOptions) {
      expect(typeof options.bucket).toBe('string');
      expect(options.bucket).not.toBe('');
      expect(options.limit).toBeGreaterThan(0);
    }
    expect(new Set(rateLimitOptions.map(o => o.bucket)).size).toBe(rateLimitOptions.length);
  });
});
