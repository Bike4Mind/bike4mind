import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * On the unauthenticated submission path, userId/username/userEmail/type/tags/content are all
 * raw request-body values. This pins that none of them can inject a tag (a clickable <a href>,
 * an <img onerror>) into the staff notification email, including userId, which used to reach
 * the email unescaped while every neighboring field was already sanitized.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: () => chain,
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FeedbackModelMock(this: any, data: unknown) {
  Object.assign(this, data, {
    id: savedFeedback.id,
    save: mockSave,
    toJSON: () => ({ id: savedFeedback.id, ...(data as object) }),
  });
}

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: FeedbackModelMock,
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
  classifyStage: (stage: string | undefined) => (stage === 'production' ? 'production' : 'nonprod'),
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

const MALICIOUS_USER_ID = '<img src=x onerror=alert(1)>';
const MALICIOUS_CONTENT = 'check this out <a href="https://evil.example">click here</a>';

const run = () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      userId: MALICIOUS_USER_ID,
      content: MALICIOUS_CONTENT,
      tags: [],
      username: 'reporter',
      userEmail: 'reporter@example.com',
    },
  });
  (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => false;
  return { req, res };
};

describe('POST /api/feedback - strips tags from the email notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not let a raw userId inject a tag into the email', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalled();
    const emailBody = mockEmailPublish.mock.calls[0][0].body as string;
    expect(emailBody).not.toContain(MALICIOUS_USER_ID);
    expect(emailBody).not.toContain('<img');
  });

  it('does not render content as a clickable link', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalled();
    const emailBody = mockEmailPublish.mock.calls[0][0].body as string;
    expect(emailBody).not.toContain('<a href');
    expect(emailBody).toContain('click here');
  });
});
