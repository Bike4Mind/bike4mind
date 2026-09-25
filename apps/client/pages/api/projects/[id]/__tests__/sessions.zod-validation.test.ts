/**
 * Regression coverage for the route's local sessionIds schemas: POST requires at least one id
 * but no longer caps the batch, and DELETE has no lower bound either since an empty removal is
 * a valid 200 no-op. The valid-body POST path is covered by sessions.credit-preflight.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAddSessions, mockRemoveSessions, mockProjectGet, mockFindUserById, mockCapturePost, mockCaptureDelete } =
  vi.hoisted(() => ({
    mockAddSessions: vi.fn(),
    mockRemoveSessions: vi.fn(),
    mockProjectGet: vi.fn(),
    mockFindUserById: vi.fn(),
    mockCapturePost: vi.fn(),
    mockCaptureDelete: vi.fn(),
  }));

// Same light chain-capture as sessions.credit-preflight.test.ts, extended to also capture DELETE.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = () => chain;
    chain.post = (handler: (...a: unknown[]) => unknown) => {
      mockCapturePost(handler);
      return chain;
    };
    chain.delete = (handler: (...a: unknown[]) => unknown) => {
      mockCaptureDelete(handler);
      return chain;
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@bike4mind/database', () => ({
  activityRepository: { createActivity: vi.fn() },
  fabFileRepository: {},
  projectRepository: {},
  sessionRepository: {},
  userRepository: { findById: mockFindUserById },
  withTransaction: (fn: () => unknown) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  projectService: {
    get: mockProjectGet,
    addSessions: mockAddSessions,
    removeSessions: mockRemoveSessions,
    listSessions: vi.fn(),
  },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ SessionEvents: { Summarize: { publish: vi.fn() } } }));
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  filterSessionIdsByOperationalCredits: vi.fn(),
}));

import '../sessions';

/** The POST and DELETE handlers the route registered, unwrapped from the mocked router chain. */
const postHandler = mockCapturePost.mock.calls[0][0] as (req: unknown, res: unknown) => Promise<void>;
const deleteHandler = mockCaptureDelete.mock.calls[0][0] as (req: unknown, res: unknown) => Promise<void>;

const REQUESTER_ID = 'requester-1';
const PROJECT_ID = 'project-1';

const run = (handler: typeof postHandler, sessionIds: unknown) => {
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  return handler(
    { user: { id: REQUESTER_ID }, query: { id: PROJECT_ID }, body: { sessionIds }, ability: {}, logger: undefined },
    res
  );
};

describe('POST /api/projects/[id]/sessions - sessionIds validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an empty sessionIds array before touching the database', async () => {
    await expect(run(postHandler, [])).rejects.toMatchObject({ name: 'ZodError' });
    expect(mockProjectGet).not.toHaveBeenCalled();
    expect(mockAddSessions).not.toHaveBeenCalled();
  });

  it('accepts 51 sessionIds - regression guard: shape is validated, no count cap is imposed', async () => {
    mockProjectGet.mockResolvedValue({ id: PROJECT_ID, name: 'proj' });
    mockFindUserById.mockResolvedValue({ id: REQUESTER_ID });
    mockAddSessions.mockResolvedValue([]);
    const ids = Array.from({ length: 51 }, (_, i) => `session-${i}`);
    await run(postHandler, ids);
    expect(mockAddSessions).toHaveBeenCalledOnce();
  });
});

describe('DELETE /api/projects/[id]/sessions - sessionIds validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts an empty sessionIds array - a 200 no-op, mirroring files.zod-validation.test.ts', async () => {
    mockRemoveSessions.mockResolvedValue({ id: PROJECT_ID, name: 'proj' });
    await run(deleteHandler, []);
    expect(mockRemoveSessions).toHaveBeenCalledOnce();
  });
});
