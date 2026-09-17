import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import errorHandler from '@server/middlewares/errorHandler';
import { FEEDBACK_ROLLUP_MAX_WINDOW_DAYS } from '@bike4mind/common';

/**
 * GET /api/feedback/rollup - the owner scope handed to the aggregate comes from the session and
 * from nowhere else. This harness replaces baseApi with a chain capture, so the auth MODE it is
 * built with is pinned here but exercised in rollup.auth.test.ts.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: unknown) => {
      mockRefs.getHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
    post: () => chain,
  };
  return {
    baseApi: (options: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

const mockAggregate = vi.fn<(pipeline: unknown, options?: unknown) => Promise<unknown[]>>(() => Promise.resolve([]));

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { aggregate: (pipeline: unknown, options: unknown) => mockAggregate(pipeline, options) },
  FeedbackTextModel: { collection: { name: 'feedbacktexts' } },
}));

import '@pages/api/feedback/rollup';

const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = '2026-01-01T00:00:00.000Z';
const at = (days: number) => new Date(Date.parse(FROM) + days * DAY_MS).toISOString();

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

function buildRequest(query: Record<string, unknown>, userId?: string) {
  const { req, res } = createMocks({ method: 'GET', query });
  if (userId) (req as unknown as { user: unknown }).user = { id: userId };
  (req as unknown as { logger: unknown }).logger = stubLogger();
  (req as unknown as { requestId: string }).requestId = 'test-request-id';
  return { req, res };
}

// Mirrors baseApi's real next-connect wiring (errorHandler is the router's onError), so a
// validation failure is asserted as the response the app would actually send.
const runHandler = async (req: unknown, res: unknown) => {
  try {
    await mockRefs.getHandler!(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scopeHandedToAggregate = () => (mockAggregate.mock.calls.at(-1)![0] as any[])[0].$match.$and[0];

describe('GET /api/feedback/rollup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAggregate.mockResolvedValue([]);
  });

  it('is built jwtOnly so an API key is never validated, metered or billed on it', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('refuses a request with no authenticated user and never touches the collection', async () => {
    const { req, res } = buildRequest({ from: at(0), to: at(7) });
    await runHandler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  it('scopes to the session user and ignores a userId in the query', async () => {
    const { req, res } = buildRequest({ from: at(0), to: at(7), userId: 'victim' }, 'session-user');
    await runHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(scopeHandedToAggregate()).toEqual({ userId: 'session-user' });
  });

  it('returns an empty rollup rather than a 404 when the window holds nothing', async () => {
    const { req, res } = buildRequest({ from: at(0), to: at(7) }, 'session-user');
    await runHandler(req, res);

    const body = res._getJSONData();
    expect(res._getStatusCode()).toBe(200);
    expect(body.total).toBe(0);
    expect(body.buckets.sessionId).toEqual({ buckets: [], truncated: false });
    expect(body.from).toBe(at(0));
    expect(body.to).toBe(at(7));
  });

  it('marks the response private and uncacheable - a per-principal aggregate must never be shared', async () => {
    const { req, res } = buildRequest({ from: at(0), to: at(7) }, 'session-user');
    await runHandler(req, res);

    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  // 422, not 400: errorHandler is the router's onError and maps a ZodError onto
  // UnprocessableEntityError, so that is the envelope a bad window actually comes back in.
  it.each([
    ['a missing window', {}],
    ['a missing upper bound', { from: at(0) }],
    ['a reversed window', { from: at(7), to: at(0) }],
    ['an empty window', { from: at(0), to: at(0) }],
    ['a non-date bound', { from: 'last tuesday', to: at(7) }],
    // 367, not FEEDBACK_ROLLUP_MAX_WINDOW_DAYS + 1: the over-cap window must be pinned to a
    // literal so this fails if the constant is ever widened, rather than scaling with it.
    ['a window past the day cap', { from: at(0), to: at(367) }],
  ])('rejects %s', async (_label, query) => {
    const { req, res } = buildRequest(query, 'session-user');
    await runHandler(req, res);

    expect(res._getStatusCode()).toBe(422);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  // Pinned so a widened constant is caught here rather than silently rescaling the literal
  // window above.
  it('pins the window cap at 366 days', () => {
    expect(FEEDBACK_ROLLUP_MAX_WINDOW_DAYS).toBe(366);
  });
});
