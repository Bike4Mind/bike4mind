import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Proves the acceptance criteria end to end through the real POST handler, not just
 * resolveFeedbackEmailRoute's return value: a non-production stage must never actually invoke
 * EmailEvents.Send.publish against the production recipient list, and the response's
 * delivery.channels.email outcome must reflect what really happened.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: () => chain,
    post: (fn: unknown) => {
      mockRefs.postHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const mockSave = vi.fn().mockResolvedValue(undefined);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FeedbackModelMock(this: any, data: unknown) {
  Object.assign(this, data, { id: 'fb1', save: mockSave, toJSON: () => ({ id: 'fb1', ...(data as object) }) });
}
FeedbackModelMock.find = vi.fn();

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: FeedbackModelMock,
  User: { findOne: vi.fn().mockReturnValue({ populate: vi.fn().mockResolvedValue(null) }) },
  adminSettingsRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/integrations/slack/slack', () => ({
  postFeedbackToSlack: vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'disabled' }),
}));

const mockEmailPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: (...args: unknown[]) => mockEmailPublish(...args) } },
}));

const settingsRefs = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn((key: string) => settingsRefs.current[key]),
}));

const configRefs = vi.hoisted(() => ({ stage: 'production' as string | undefined }));
vi.mock('@server/utils/config', () => ({
  Config: {
    get STAGE() {
      return configRefs.stage;
    },
  },
  classifyStage: (stage: string | undefined) => (stage === 'production' ? 'production' : 'nonprod'),
}));

vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordFeedbackDeliverySuccess: vi.fn(),
  recordFeedbackDeliveryFailure: vi.fn(),
  recordFeedbackDeliverySkipped: vi.fn(),
  ALARM_WORTHY_SKIP_REASONS: ['unconfigured_webhook', 'no_recipients'],
}));

import '../index';

const run = () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      userId: 'user-1',
      content: 'it broke',
      tags: [],
      username: 'reporter',
      userEmail: 'reporter@example.com',
    },
  });
  (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => false;
  return { req, res };
};

describe('POST /api/feedback - stage-aware email routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsRefs.current = { EnableFeedBackToEmail: true };
    configRefs.stage = 'production';
  });

  it('production stage sends only to FeedbackReceiveEmail', async () => {
    settingsRefs.current.FeedbackReceiveEmail = 'prod-team@example.com';
    settingsRefs.current.FeedbackReceiveEmailNonProd = 'staging-team@example.com';

    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalledTimes(1);
    expect(mockEmailPublish.mock.calls[0][0].to).toBe('prod-team@example.com');
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'delivered' });
  });

  it('a non-prod stage with FeedbackReceiveEmailNonProd set sends only to that list', async () => {
    configRefs.stage = 'pr-1234';
    settingsRefs.current.FeedbackReceiveEmail = 'prod-team@example.com';
    settingsRefs.current.FeedbackReceiveEmailNonProd = 'staging-team@example.com';

    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalledTimes(1);
    expect(mockEmailPublish.mock.calls[0][0].to).toBe('staging-team@example.com');
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'delivered' });
  });

  it('a non-prod stage with FeedbackReceiveEmailNonProd unset never mails the prod list', async () => {
    configRefs.stage = 'pr-1234';
    settingsRefs.current.FeedbackReceiveEmail = 'prod-team@example.com';

    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'skipped', reason: 'nonprod_unconfigured' });
  });
});
