import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { accessibleBy } from '@casl/mongoose';
import errorHandler from '@server/middlewares/errorHandler';

/**
 * GET /api/feedback - server-side filter/projection/pagination over FeedbackModel. The CASL
 * ability rules ARE the scope (accessibleBy narrows to {} for an admin's unconditional read grant,
 * or to an ownership filter for anyone else); free-text search resolves through the TTL'd
 * FeedbackTextModel sibling, since `content` does not live on the report itself.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
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
  return { baseApi: () => chain };
});

const mockListDocs = vi.fn<() => unknown[]>(() => []);
const mockSelect = vi.fn();
const mockSort = vi.fn();
const mockSkip = vi.fn();
const mockLimit = vi.fn();
// The route chains .select().sort().skip().limit() before awaiting, so the mock has to be a
// thenable query rather than a resolved array - mirrors redaction.test.ts's harness.
const mockFind = vi.fn((_filter: unknown) => {
  const query = {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return query;
    },
    sort: (...args: unknown[]) => {
      mockSort(...args);
      return query;
    },
    skip: (...args: unknown[]) => {
      mockSkip(...args);
      return query;
    },
    limit: (...args: unknown[]) => {
      mockLimit(...args);
      return query;
    },
    then: (resolve: (docs: unknown[]) => unknown) => resolve(mockListDocs()),
  };
  return query;
});
const mockCountDocuments = vi.fn().mockResolvedValue(0);
const mockDistinct = vi.fn().mockResolvedValue([]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FeedbackModelMock(this: any, data: unknown) {
  Object.assign(this, data);
}
FeedbackModelMock.find = mockFind;
FeedbackModelMock.countDocuments = mockCountDocuments;
FeedbackModelMock.distinct = mockDistinct;

// The route chains .select('_id').lean() off FeedbackTextModel.find before awaiting it.
const mockTextFind = vi.fn().mockReturnValue({ select: () => ({ lean: vi.fn().mockResolvedValue([]) }) });

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: FeedbackModelMock,
  FeedbackTextModel: { find: (...args: unknown[]) => mockTextFind(...args) },
  User: {},
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/utils', () => ({
  escapeRegex: (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/integrations/slack/slack', () => ({ postFeedbackToSlack: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@server/utils/config', () => ({ Config: { STAGE: 'production' } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@server/utils/cloudwatch', async () => {
  const actual = await vi.importActual<typeof import('@server/utils/cloudwatch')>('@server/utils/cloudwatch');
  return {
    recordFeedbackDeliverySuccess: vi.fn(),
    recordFeedbackDeliveryFailure: vi.fn(),
    recordFeedbackDeliverySkipped: vi.fn(),
    ALARM_WORTHY_SKIP_REASONS: actual.ALARM_WORTHY_SKIP_REASONS,
  };
});

// The page bounds are shared with the client (the CSV export pages at exactly the maximum), so
// they live in common; only the projection allowlist belongs to the route.
import { FEEDBACK_LIST_DEFAULT_LIMIT, FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';
import { FEEDBACK_LIST_FIELDS } from '../index';

/**
 * Built inline rather than imported from server/auth/ability.ts, which pulls an unresolvable
 * `tldts` transitive dependency under this vitest setup. MUST STAY IN SYNC with the admin feedback
 * rules there: an unconditional read grant is what makes accessibleBy narrow to {}.
 */
const adminAbility = () => {
  const { can, build } = new AbilityBuilder(createMongoAbility);
  can('read', FeedbackModelMock);
  return build();
};

const ownAbility = (userId: string) => {
  const { can, build } = new AbilityBuilder(createMongoAbility);
  can('read', FeedbackModelMock, { userId });
  return build();
};

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

function buildRequest(query: Record<string, unknown>, ability: unknown) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as { ability: unknown }).ability = ability;
  (req as unknown as { logger: unknown }).logger = stubLogger();
  (req as unknown as { requestId: string }).requestId = 'test-request-id';
  return { req, res };
}

// Mirrors the real onError wiring in baseApi's next-connect router (errorHandler is the router's
// onError), so a thrown validation error is asserted as the actual HTTP response the app would
// send, not just an uncaught rejection - this test bypasses baseApi's real router entirely.
const runHandler = async (req: unknown, res: unknown) => {
  try {
    await mockRefs.getHandler!(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
};

describe('GET /api/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDocs.mockReturnValue([]);
    mockCountDocuments.mockResolvedValue(0);
    mockDistinct.mockResolvedValue([]);
    mockTextFind.mockReturnValue({ select: () => ({ lean: vi.fn().mockResolvedValue([]) }) });
  });

  it('maps page and limit to skip and limit on the query', async () => {
    const { req, res } = buildRequest({ page: '3', limit: '10' }, adminAbility());
    await runHandler(req, res);

    expect(mockSkip).toHaveBeenCalledWith(20);
    expect(mockLimit).toHaveBeenCalledWith(10);
  });

  it('defaults to page 1 and the default limit with no query params', async () => {
    const { req, res } = buildRequest({}, adminAbility());
    await runHandler(req, res);

    expect(mockSkip).toHaveBeenCalledWith(0);
    expect(mockLimit).toHaveBeenCalledWith(FEEDBACK_LIST_DEFAULT_LIMIT);
    const body = res._getJSONData();
    expect(body.page).toBe(1);
    expect(body.limit).toBe(FEEDBACK_LIST_DEFAULT_LIMIT);
  });

  it('rejects a limit above FEEDBACK_LIST_MAX_LIMIT with a 422, not a 400', async () => {
    const { req, res } = buildRequest({ limit: String(FEEDBACK_LIST_MAX_LIMIT + 1) }, adminAbility());
    await runHandler(req, res);

    // ListFeedbackQuerySchema.parse throws a ZodError, which errorHandler maps to
    // UnprocessableEntityError (422) - see server/middlewares/errorHandler.ts.
    expect(res._getStatusCode()).toBe(422);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('projects only the list allowlist, never promptMeta', async () => {
    const { req, res } = buildRequest({}, adminAbility());
    await runHandler(req, res);

    expect(mockSelect).toHaveBeenCalledWith(FEEDBACK_LIST_FIELDS);
    const selected = mockSelect.mock.calls[0][0] as string;
    expect(selected).not.toContain('promptMeta');
  });

  it('returns exactly items/total/page/limit/organizations, sourced from countDocuments and distinct', async () => {
    mockListDocs.mockReturnValue([]);
    mockCountDocuments.mockResolvedValue(7);
    mockDistinct.mockResolvedValue(['Acme', 'Beta']);

    const { req, res } = buildRequest({ page: '2', limit: '5' }, adminAbility());
    await runHandler(req, res);

    const body = res._getJSONData();
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'organizations', 'page', 'total']);
    expect(body.total).toBe(7);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(5);
    expect(body.organizations).toEqual(['Acme', 'Beta']);
  });

  it('computes the organization facet over the accessible set, not the org-filtered set', async () => {
    const { req, res } = buildRequest({ organization: 'acme' }, adminAbility());
    await runHandler(req, res);

    // Selecting an org must not prune the dropdown that selected it: distinct() has to see every
    // organization the caller can access, so it takes the unfiltered accessible-set query.
    const distinctFilter = mockDistinct.mock.calls[0][1];
    expect(JSON.stringify(distinctFilter)).not.toContain('acme');

    const findFilter = mockFind.mock.calls[0][0] as { $and: unknown[] };
    expect(JSON.stringify(findFilter.$and)).toContain('acme');
  });

  it('narrows a non-admin caller to their own records via the ability, not a hand-written filter', async () => {
    const ability = ownAbility('user-1');
    const { req, res } = buildRequest({}, ability);
    await runHandler(req, res);

    // Read the real shape accessibleBy produces for this ability rather than assuming one - the
    // route's `readable` clause is exactly this value.
    const expectedReadable = accessibleBy(ability, 'read').ofType(FeedbackModelMock);
    const findFilter = mockFind.mock.calls[0][0] as { $and: unknown[] };
    expect(findFilter.$and[0]).toEqual(expectedReadable);
    expect(JSON.stringify(expectedReadable)).toContain('user-1');
  });

  it('resolves free-text search through the FeedbackText sibling and filters by matching ids', async () => {
    mockTextFind.mockReturnValue({
      select: () => ({ lean: vi.fn().mockResolvedValue([{ _id: 'match-1' }, { _id: 'match-2' }]) }),
    });

    const { req, res } = buildRequest({ search: 'crash' }, adminAbility());
    await runHandler(req, res);

    expect(mockTextFind).toHaveBeenCalledWith({ content: expect.any(RegExp) });
    expect(mockTextFind.mock.calls[0][0].content.source).toContain('crash');

    const findFilter = mockFind.mock.calls[0][0] as { $and: unknown[] };
    const serialized = JSON.stringify(findFilter.$and);
    expect(serialized).toContain('match-1');
    expect(serialized).toContain('match-2');
  });
});
