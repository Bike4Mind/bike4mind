/**
 * The fan-out half of the session-event credit gate: POST /api/projects/[id]/sessions attaches
 * notebooks and publishes a Summarize per notebook.
 *
 * Two decisions live here and nowhere else, so neither is visible in the shared helper's unit
 * suite. First, the attach must SUCCEED even when the summary cannot be paid for - it is a free
 * action, the fan-out is best-effort, and failing it would take a working feature away from any
 * user who happens to be out of credits. Second, the fan-out iterates the RESOLVED sessions, not
 * the request's raw id list, so a duplicated id neither queues nor pays for two identical
 * summaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFilterCredits,
  mockAddSessions,
  mockProjectGet,
  mockPublishSummarize,
  mockLogEvent,
  mockFindUserById,
  mockCapturePost,
} = vi.hoisted(() => ({
  mockFilterCredits: vi.fn(),
  mockAddSessions: vi.fn(),
  mockProjectGet: vi.fn(),
  mockPublishSummarize: vi.fn(),
  mockLogEvent: vi.fn(),
  mockFindUserById: vi.fn(),
  mockCapturePost: vi.fn(),
}));

// The route chains .get().post().delete(); capturing the POST handler off the chain is simpler
// than faking a router that has to survive all three.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = () => chain;
    chain.delete = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => {
      mockCapturePost(handler);
      return chain;
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@bike4mind/database', () => ({
  activityRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  sessionRepository: {},
  userRepository: { findById: mockFindUserById },
  withTransaction: (fn: () => unknown) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  projectService: { get: mockProjectGet, addSessions: mockAddSessions, listSessions: vi.fn() },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: mockLogEvent }));
vi.mock('@server/utils/eventBus', () => ({ SessionEvents: { Summarize: { publish: mockPublishSummarize } } }));
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  filterSessionIdsByOperationalCredits: mockFilterCredits,
  OPERATIONS_PER_SUMMARIZE_WITH_TAGGING: 2,
}));

import '../sessions';

/** The POST handler the route registered, unwrapped from the mocked router chain. */
const postHandler = mockCapturePost.mock.calls[0][0] as (req: unknown, res: unknown) => Promise<void>;

const REQUESTER_ID = 'requester-1';
const PROJECT_ID = 'project-1';

/** Two notebooks, owned by different users - the shape that makes a partial refusal meaningful. */
const RESOLVED_SESSIONS = [
  { id: 'session-payable', userId: 'owner-funded' },
  { id: 'session-unpayable', userId: 'owner-broke' },
];

const run = async (sessionIds: string[]) => {
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  await postHandler(
    {
      user: { id: REQUESTER_ID },
      query: { id: PROJECT_ID },
      body: { sessionIds },
      ability: {},
      logger: undefined,
    },
    res
  );
  return res;
};

describe('POST /api/projects/[id]/sessions credit pre-flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectGet.mockResolvedValue({ id: PROJECT_ID, name: 'Project One' });
    mockFindUserById.mockResolvedValue({ id: REQUESTER_ID });
    mockAddSessions.mockResolvedValue(RESOLVED_SESSIONS);
    mockFilterCredits.mockResolvedValue(new Set(RESOLVED_SESSIONS.map(s => s.id)));
    mockPublishSummarize.mockResolvedValue('req-1');
  });

  it('prices each notebook at the summary plus the tag it cascades to', async () => {
    await run(['session-payable', 'session-unpayable']);

    expect(mockFilterCredits).toHaveBeenCalledWith(
      RESOLVED_SESSIONS,
      expect.objectContaining({ operationsPerSession: 2, operation: 'session summarization' })
    );
  });

  // `addSessions` returns one row per distinct notebook, so sizing and queueing off its result
  // rather than off `req.body.sessionIds` is what stops a repeated id paying twice.
  it('sizes the check against the resolved sessions, not the requested id list', async () => {
    await run(['session-payable', 'session-payable', 'session-unpayable', 'session-not-accessible']);

    expect(mockFilterCredits).toHaveBeenCalledWith(RESOLVED_SESSIONS, expect.anything());
    expect(mockPublishSummarize).toHaveBeenCalledTimes(2);
  });

  it('queues a summary for every notebook whose owner can pay', async () => {
    await run(['session-payable', 'session-unpayable']);

    expect(mockPublishSummarize).toHaveBeenCalledTimes(2);
    for (const session of RESOLVED_SESSIONS) {
      expect(mockPublishSummarize).toHaveBeenCalledWith({
        sessionId: session.id,
        callTagging: true,
        trigger: 'project',
      });
    }
  });

  // The whole reason this call site takes a verdict instead of throwing one.
  it('still attaches, logs and responds when an owner cannot pay for their summary', async () => {
    mockFilterCredits.mockResolvedValue(new Set(['session-payable']));

    const res = await run(['session-payable', 'session-unpayable']);

    expect(mockPublishSummarize).toHaveBeenCalledTimes(1);
    expect(mockPublishSummarize).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-payable', trigger: 'project' })
    );
    // The attach itself happened for both, and the activity is recorded for both: a skipped
    // summary is not a skipped attach.
    expect(mockAddSessions).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalled();
  });

  it('publishes nothing when no owner can pay, and still succeeds', async () => {
    mockFilterCredits.mockResolvedValue(new Set<string>());

    const res = await run(['session-payable', 'session-unpayable']);

    expect(mockPublishSummarize).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });
});
