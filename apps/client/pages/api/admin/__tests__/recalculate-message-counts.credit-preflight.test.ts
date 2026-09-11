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
const UNGROOMED_PER_OPERATION = 6;

/** Field the handler counts as "still to do" for each spending operation. */
const ungroomedField = (call: unknown[]) => {
  const filter = call[0] as Record<string, unknown>;
  return Object.keys(filter).find(key => key.endsWith('At') && filter[key] === null);
};

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
    // The total is the first call (progress reporting); each spending operation then counts
    // only the notebooks it would actually groom.
    mockCount.mockImplementation(async (filter: Record<string, unknown>) =>
      'summaryAt' in filter || 'taggedAt' in filter ? UNGROOMED_PER_OPERATION : TOTAL_NOTEBOOKS
    );
    mockAssertCredits.mockResolvedValue(undefined);
    mockPublishStart.mockResolvedValue(undefined);
  });

  // The batch is what makes the spider the largest operational spend on the platform: a check
  // sized to one notebook would wave through a 50-notebook fan-out against an empty pool.
  it('sums one ungroomed count per spending operation', async () => {
    await run({ operations: ['summarize', 'tags'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', operationCount: UNGROOMED_PER_OPERATION * 2 })
    );
    expect(mockCount.mock.calls.map(ungroomedField).filter(Boolean).sort()).toEqual(['summaryAt', 'taggedAt']);
  });

  // The spider skips an already-groomed notebook (`!session.summaryAt` / `!session.taggedAt`), so
  // pricing a re-run at totalNotebooks would refuse a large account credits for work it will not
  // do - the gate would make the spider unusable above a few hundred notebooks.
  it('sizes the check to the ungroomed notebooks, not to every notebook the admin owns', async () => {
    await run({ operations: ['summarize'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operationCount: UNGROOMED_PER_OPERATION })
    );
  });

  // Nothing left to groom must cost nothing: the pre-flight short-circuits a zero count.
  it('asks for nothing when every notebook is already groomed', async () => {
    mockCount.mockImplementation(async (filter: Record<string, unknown>) =>
      'summaryAt' in filter || 'taggedAt' in filter ? 0 : TOTAL_NOTEBOOKS
    );

    await run({ operations: ['summarize', 'tags'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(expect.objectContaining({ operationCount: 0 }));
  });

  // messageCount is a pure recount; curation publishes to a handler with no billing path and the
  // spider generates embeddings inline without recording usage. Counting them would refuse runs
  // that cost nothing on this path.
  it('excludes the operations that never settle through recordOperationalUsage', async () => {
    await run({ operations: ['messageCount', 'curation', 'embeddings', 'summarize'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operationCount: UNGROOMED_PER_OPERATION })
    );
  });

  // The operations list comes off the request body, so a repeat must not double the price.
  it('does not double-count a repeated operation', async () => {
    await run({ operations: ['summarize', 'summarize'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operationCount: UNGROOMED_PER_OPERATION })
    );
  });

  it('skips the check, and its counts, for a dry run', async () => {
    await run({ dryRun: true, operations: ['summarize', 'tags'] });

    expect(mockAssertCredits).not.toHaveBeenCalled();
    expect(mockCount.mock.calls.map(ungroomedField).filter(Boolean)).toEqual([]);
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
