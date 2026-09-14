import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';

/**
 * A bug report leaves the product entirely (a third-party Slack workspace, unencrypted email).
 * promptMeta.functionCalls[].returnValue can hold verbatim tool output the reporter never chose
 * to disclose to those destinations just by clicking "report a bug" - this pins that the redacted
 * copy is what reaches Slack/email, while the full promptMeta is still what gets saved to
 * FeedbackModel (an admin-gated, in-product record).
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: unknown) => {
      mockRefs.getHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const savedFeedback = { id: 'fb1' };
const mockSave = vi.fn().mockResolvedValue(undefined);
// The list route chains .select().sort().skip().limit() before awaiting, so the mock has to be a
// thenable query rather than a resolved array.
const mockListDocs = vi.fn<() => unknown[]>(() => []);
const mockFind = vi.fn(() => {
  const query = {
    select: () => query,
    sort: () => query,
    skip: () => query,
    limit: () => query,
    then: (resolve: (docs: unknown[]) => unknown) => resolve(mockListDocs()),
  };
  return query;
});
const mockCountDocuments = vi.fn().mockResolvedValue(1);
const mockDistinct = vi.fn().mockResolvedValue([]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FeedbackModelMock(this: any, data: unknown) {
  Object.assign(this, data, {
    id: savedFeedback.id,
    save: mockSave,
    toJSON: () => ({ id: savedFeedback.id, ...(data as object) }),
  });
}
FeedbackModelMock.find = mockFind;
FeedbackModelMock.countDocuments = mockCountDocuments;
FeedbackModelMock.distinct = mockDistinct;

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: FeedbackModelMock,
  FeedbackTextModel: {
    create: vi.fn().mockResolvedValue({}),
    deleteOne: vi.fn().mockResolvedValue({}),
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
  },
  User: { findOne: vi.fn().mockReturnValue({ populate: vi.fn().mockResolvedValue(null) }) },
  adminSettingsRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

const mockPostFeedbackToSlack = vi.fn().mockResolvedValue({ outcome: 'delivered' });
vi.mock('@server/integrations/slack/slack', () => ({
  postFeedbackToSlack: (...args: unknown[]) => mockPostFeedbackToSlack(...args),
}));

const mockEmailPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: (...args: unknown[]) => mockEmailPublish(...args) } },
}));

vi.mock('@bike4mind/utils', () => ({
  escapeRegex: (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn((key: string) => {
    if (key === 'EnableFeedBackToSlack') return true;
    if (key === 'EnableFeedBackToEmail') return true;
    if (key === 'FeedbackReceiveEmail') return 'team@example.com';
    return undefined;
  }),
}));

vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'production' },
}));

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

import '../index';

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

const PROMPT_META_WITH_TOOL_OUTPUT = {
  functionCalls: [
    { name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'PRIVATE TOOL OUTPUT', success: true },
  ],
};

const run = () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      userId: 'user-1',
      content: 'it broke',
      tags: [],
      username: 'reporter',
      userEmail: 'reporter@example.com',
      promptMeta: PROMPT_META_WITH_TOOL_OUTPUT,
    },
  });
  (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => false;
  return { req, res };
};

describe('POST /api/feedback - redacts tool output before third-party egress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the full promptMeta to FeedbackModel', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockSave).toHaveBeenCalled();
    const saved = mockSave.mock.instances[0] as unknown as { promptMeta: typeof PROMPT_META_WITH_TOOL_OUTPUT };
    expect(JSON.stringify(saved.promptMeta)).toContain('PRIVATE TOOL OUTPUT');
  });

  it('does not send returnValue to Slack', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockPostFeedbackToSlack).toHaveBeenCalled();
    const slackPromptMetaArg = mockPostFeedbackToSlack.mock.calls[0][6];
    expect(JSON.stringify(slackPromptMetaArg)).not.toContain('PRIVATE TOOL OUTPUT');
    expect(JSON.stringify(slackPromptMetaArg)).toContain('web_search');
  });

  it('does not send returnValue to email', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalled();
    const emailBody = mockEmailPublish.mock.calls[0][0].body as string;
    expect(emailBody).not.toContain('PRIVATE TOOL OUTPUT');
  });
});

describe('GET /api/feedback - redacts tool output before returning it to an admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips returnValue from every reporters functionCalls', async () => {
    mockListDocs.mockReturnValue([{ toJSON: () => ({ id: 'fb1', promptMeta: PROMPT_META_WITH_TOOL_OUTPUT }) }]);
    const { req, res } = createMocks({ method: 'GET' });
    // A real ability, not a { can: () => true } stub: the route derives its Mongo scope from the
    // rules via accessibleBy, which needs the actual CASL instance.
    (req as unknown as { ability: unknown }).ability = adminAbility();

    await mockRefs.getHandler!(req, res);

    const body = JSON.stringify(res._getJSONData());
    expect(body).not.toContain('PRIVATE TOOL OUTPUT');
    expect(body).toContain('web_search');
  });
});
