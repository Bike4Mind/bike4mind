import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockAssertCredits, mockCount, mockCountTaggable, mockPublishStart } = vi.hoisted(() => ({
  mockAssertCredits: vi.fn(),
  mockCount: vi.fn(),
  mockCountTaggable: vi.fn(),
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
vi.mock('@bike4mind/database/auth', () => ({
  sessionRepository: { count: mockCount, countTaggableNotebooks: mockCountTaggable },
}));
vi.mock('@server/utils/eventBus', () => ({ SpiderEvents: { Start: { publish: mockPublishStart } } }));
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  assertSessionOperationalCredits: mockAssertCredits,
}));

import handler from '../recalculate-message-counts';

const TOTAL_NOTEBOOKS = 50;
const UNGROOMED_PER_OPERATION = 6;

/**
 * Field a raw `count` call treats as "still to do". Only the `summarize` leg builds its filter
 * here; `tags` goes through `sessionRepository.countTaggableNotebooks`, which is why several
 * assertions below check that no `taggedAt` filter is ever issued.
 */
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
    //
    // These are the counts the handler ASKS for, which is what this file is about; what they
    // match against a real collection is SPENDING_SPIDER_OPERATIONS' concern, not this file's.
    mockCount.mockImplementation(async (filter: Record<string, unknown>) =>
      'summaryAt' in filter ? UNGROOMED_PER_OPERATION : TOTAL_NOTEBOOKS
    );
    mockCountTaggable.mockResolvedValue(UNGROOMED_PER_OPERATION);
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
    expect(mockCount.mock.calls.map(ungroomedField).filter(Boolean)).toEqual(['summaryAt']);
    expect(mockCountTaggable).toHaveBeenCalledTimes(1);
    expect(mockCountTaggable).toHaveBeenCalledWith('admin-1');
  });

  // The `tags` leg must never go back to a plain `{ taggedAt: null }` count. `sessionTagging.ts`
  // aborts before the model on a notebook with no quests and writes nothing, so that count prices
  // a dispatch that settles nothing, re-prices it on every run, and refuses a low-balance admin a
  // run that would have cost them nothing.
  it('prices the tags leg through countTaggableNotebooks rather than a taggedAt count', async () => {
    await run({ operations: ['tags'] });

    expect(mockCountTaggable).toHaveBeenCalledWith('admin-1');
    expect(mockCount.mock.calls.map(ungroomedField).filter(Boolean)).toEqual([]);
    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operationCount: UNGROOMED_PER_OPERATION })
    );
  });

  // A soft-deleted notebook is not work the spider will do, so counting one would price the gate
  // above the real spend. The `summarize` leg builds its filter in this module, so its `deletedAt`
  // clause is this file's to pin - a missing clause is invisible in the operationCount assertions
  // above, which read whatever the mock returns. The `tags` leg's exclusions (soft-deleted
  // notebook, soft-deleted quest, other owner) live in `countTaggableNotebooks` and are pinned
  // against a real mongod in packages/database/src/models/auth.
  it('excludes soft-deleted notebooks from the summarize ungroomed count', async () => {
    await run({ operations: ['summarize', 'tags'] });

    const ungroomedCalls = mockCount.mock.calls.filter(([filter]) => Boolean(ungroomedField([filter])));
    expect(ungroomedCalls).toHaveLength(1);
    expect(ungroomedCalls[0][0]).toMatchObject({
      userId: 'admin-1',
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    });
  });

  // The spider skips an already-groomed notebook (`!session.summaryAt` / `!session.taggedAt`), so
  // pricing a re-run at totalNotebooks would refuse a large account credits for work it will not
  // do - the gate would make the spider unusable above a few hundred notebooks.
  //
  // `summarize` on purpose: one leg is enough to pin the sizing, and it is the leg whose filter
  // is built here.
  it('sizes the summarize leg to the ungroomed notebooks, not to every notebook the admin owns', async () => {
    await run({ operations: ['summarize'] });

    expect(mockAssertCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operationCount: UNGROOMED_PER_OPERATION })
    );
  });

  // Nothing left to groom must cost nothing: the pre-flight short-circuits a zero count.
  it('asks for nothing when every notebook is already groomed', async () => {
    mockCount.mockImplementation(async (filter: Record<string, unknown>) =>
      'summaryAt' in filter ? 0 : TOTAL_NOTEBOOKS
    );
    mockCountTaggable.mockResolvedValue(0);

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
    expect(mockCountTaggable).not.toHaveBeenCalled();
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
