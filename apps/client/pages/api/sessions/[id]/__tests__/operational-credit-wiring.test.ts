/**
 * What the two single-session publishers ASK the credit pre-flight for. The helper's own
 * behaviour is covered by server/utils/sessionOperationalCreditPreflight.test.ts; this file
 * covers the arguments, which the helper cannot check for itself and which a reader cannot infer
 * from a green unit suite.
 *
 * The load-bearing one is the holder: `userId` must be the SESSION OWNER and `requesterId` the
 * caller. Both are strings on the same request, so swapping them type-checks, passes every unit
 * test, and silently gates the wrong balance in both directions - a broke requester blocking a
 * funded owner's summary, and a broke owner's work billed against a funded requester.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAssertCredits, mockFindOne, mockPublishTag, mockPublishSummarize } = vi.hoisted(() => ({
  mockAssertCredits: vi.fn(),
  mockFindOne: vi.fn(),
  mockPublishTag: vi.fn(),
  mockPublishSummarize: vi.fn(),
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
vi.mock('@bike4mind/database/auth', () => ({ Session: { findOne: mockFindOne } }));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: { Tag: { publish: mockPublishTag }, Summarize: { publish: mockPublishSummarize } },
}));
// The constant has to be declared here too: an export the real module has and the mock does not
// arrives as `undefined`, which would make summary.ts's operationCount assertion vacuous.
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  assertSessionOperationalCredits: mockAssertCredits,
  OPERATIONS_PER_SUMMARIZE_WITH_TAGGING: 2,
}));

import tagHandler from '../tag';
import summaryHandler from '../summary';

const OWNER_ID = 'owner-1';
const REQUESTER_ID = 'requester-2';
const SESSION_ID = 'session-1';

const run = async (handler: unknown) => {
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  await (handler as (req: unknown, res: unknown) => Promise<void>)(
    {
      user: { id: REQUESTER_ID },
      query: { id: SESSION_ID },
      ability: {},
      logger: undefined,
    },
    res
  );
  return res;
};

describe('session operational credit pre-flight wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A session shared into the requester with update permission: the owner is someone else,
    // which is the case that tells the two ids apart.
    mockFindOne.mockResolvedValue({ id: SESSION_ID, userId: OWNER_ID });
    mockAssertCredits.mockResolvedValue(undefined);
    mockPublishTag.mockResolvedValue('req-1');
    mockPublishSummarize.mockResolvedValue('req-2');
  });

  describe('POST /api/sessions/[id]/tag', () => {
    it('bills the session owner and names the requester, sized to the single tag it queues', async () => {
      await run(tagHandler);

      expect(mockAssertCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER_ID,
          requesterId: REQUESTER_ID,
          operationCount: 1,
          operation: 'session tagging',
        })
      );
    });

    it('queues nothing when the pre-flight refuses', async () => {
      mockAssertCredits.mockRejectedValue(new Error('insufficient credits'));

      await expect(run(tagHandler)).rejects.toThrow('insufficient credits');
      expect(mockPublishTag).not.toHaveBeenCalled();
    });

    it('checks credits before publishing, not after', async () => {
      await run(tagHandler);

      expect(mockAssertCredits.mock.invocationCallOrder[0]).toBeLessThan(mockPublishTag.mock.invocationCallOrder[0]);
    });
  });

  describe('POST /api/sessions/[id]/summary', () => {
    // Summarize publishes with `callTagging`, so it must be priced at the summary PLUS the tag it
    // cascades to - pricing it at 1 would under-charge every manual summary on the platform.
    it('bills the session owner for both the summary and the tag it cascades to', async () => {
      await run(summaryHandler);

      expect(mockAssertCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER_ID,
          requesterId: REQUESTER_ID,
          operationCount: 2,
          operation: 'session summarization',
        })
      );
    });

    it('queues nothing when the pre-flight refuses', async () => {
      mockAssertCredits.mockRejectedValue(new Error('insufficient credits'));

      await expect(run(summaryHandler)).rejects.toThrow('insufficient credits');
      expect(mockPublishSummarize).not.toHaveBeenCalled();
    });

    it('checks credits before publishing, not after', async () => {
      await run(summaryHandler);

      expect(mockAssertCredits.mock.invocationCallOrder[0]).toBeLessThan(
        mockPublishSummarize.mock.invocationCallOrder[0]
      );
    });
  });
});
