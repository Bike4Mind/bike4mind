import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockAssertCredits, mockCount, mockPublishStart } = vi.hoisted(() => ({
  mockAssertCredits: vi.fn(),
  mockCount: vi.fn(),
  mockPublishStart: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@bike4mind/database/auth', () => ({ sessionRepository: { count: mockCount } }));
vi.mock('@server/utils/eventBus', () => ({ SpiderEvents: { Start: { publish: mockPublishStart } } }));
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  assertSessionOperationalCredits: mockAssertCredits,
}));

import handler from '../recalculate-message-counts';

const TOTAL_NOTEBOOKS = 50;

const run = async (body: Record<string, unknown>) => {
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { user: { id: 'admin-1', isAdmin: true }, query: {}, body, logger: undefined },
    res
  );
  return res;
};

describe('POST /api/admin/recalculate-message-counts credit pre-flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCount.mockResolvedValue(TOTAL_NOTEBOOKS);
    mockAssertCredits.mockResolvedValue(undefined);
    mockPublishStart.mockResolvedValue(undefined);
  });

  // The batch is what makes the spider the largest operational spend on the platform: a check
  // sized to one notebook would wave through a 50-notebook fan-out against an empty pool.
  it('sizes the check by notebooks x spending operations', async () => {
    await run({ operations: ['summarize', 'tags'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', operationCount: TOTAL_NOTEBOOKS * 2 })
    );
  });

  // messageCount is a pure recount and curation/embeddings settle through their own handlers, so
  // counting them would refuse runs that cost nothing on this path.
  it('excludes the operations that never settle through recordOperationalUsage', async () => {
    await run({ operations: ['messageCount', 'curation', 'embeddings', 'summarize'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operationCount: TOTAL_NOTEBOOKS * 1 })
    );
  });

  it('skips the check for a dry run, which performs no model calls', async () => {
    await run({ dryRun: true, operations: ['summarize', 'tags'] });

    expect(mockAssertCredits).not.toHaveBeenCalled();
    expect(mockPublishStart).toHaveBeenCalled();
  });

  // The refusal must reach the caller as its own 422, not be flattened into this handler's
  // catch-all 500 - the admin UI renders the body's `error` string verbatim, so a swallowed
  // refusal reads to an admin as "the spider is broken".
  it('propagates a credit refusal rather than converting it to a 500, and queues nothing', async () => {
    const { UnprocessableEntityError } = await import('@bike4mind/common');
    mockAssertCredits.mockRejectedValue(new UnprocessableEntityError('Out of credits'));

    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const thrown = await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { user: { id: 'admin-1', isAdmin: true }, query: {}, body: { operations: ['summarize'] }, logger: undefined },
      res
    ).catch((err: unknown) => err);

    expect((thrown as Error).message).toBe('Out of credits');
    expect(res.status).not.toHaveBeenCalled();
    expect(mockPublishStart).not.toHaveBeenCalled();
  });

  // A genuine failure still takes the handler's own 500 path - the rethrow above must be scoped
  // to HTTPError, not a blanket "rethrow everything" that changes this route's error contract.
  it('still converts a non-HTTP failure into the handler 500', async () => {
    mockCount.mockRejectedValue(new Error('mongo down'));

    const res = await run({ operations: ['summarize'] });

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
