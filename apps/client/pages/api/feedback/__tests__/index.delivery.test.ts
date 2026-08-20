import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Each of the four independent delivery gates (EnableFeedBackToSlack, EnableFeedBackToEmail +
 * a non-empty FeedbackReceiveEmail, the webhook-URL configuration, and the deploy-stage routing)
 * must fail or succeed on its own without the submitter being told delivery succeeded when no
 * channel actually fired. Slack's stage-routing gate is covered independently in slack.test.ts,
 * and email's resolver logic in isolation in resolveFeedbackEmailRoute.test.ts; this file covers
 * the route's aggregation of postFeedbackToSlack's reported outcome plus the email path
 * end-to-end, including the email channel's own stage-based routing.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: unknown) => chain,
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

const mockPostFeedbackToSlack = vi.fn();
vi.mock('@server/integrations/slack/slack', () => ({
  postFeedbackToSlack: (...args: unknown[]) => mockPostFeedbackToSlack(...args),
}));

const mockEmailPublish = vi.fn();
vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: (...args: unknown[]) => mockEmailPublish(...args) } },
}));

const mockSettings = vi.hoisted(() => ({
  EnableFeedBackToSlack: false as boolean,
  EnableFeedBackToEmail: false as boolean,
  FeedbackReceiveEmail: '' as string,
  FeedbackReceiveEmailNonProd: '' as string,
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn((key: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mockSettings as any)[key];
  }),
}));

const mockConfig = vi.hoisted(() => ({ STAGE: 'production' as string | undefined }));
vi.mock('@server/utils/config', () => ({
  Config: mockConfig,
  classifyStage: (stage: string | undefined) => (stage === 'production' ? 'production' : 'nonprod'),
}));

vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const mockRecordSuccess = vi.fn();
const mockRecordFailure = vi.fn();
const mockEmitMetrics = vi.fn();
vi.mock('@server/utils/cloudwatch', async () => {
  const actual = await vi.importActual<typeof import('@server/utils/cloudwatch')>('@server/utils/cloudwatch');
  return {
    recordFeedbackDeliverySuccess: (...args: unknown[]) => mockRecordSuccess(...args),
    recordFeedbackDeliveryFailure: (...args: unknown[]) => mockRecordFailure(...args),
    // Pure builder - safe to pass through unmocked; only the AWS-calling emit needs a mock.
    buildFeedbackDeliverySkippedMetrics: actual.buildFeedbackDeliverySkippedMetrics,
    emitFeedbackDeliveryMetrics: (...args: unknown[]) => mockEmitMetrics(...args),
    ALARM_WORTHY_SKIP_REASONS: actual.ALARM_WORTHY_SKIP_REASONS,
  };
});

import '../index';
import { Logger } from '@bike4mind/observability';

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

describe('POST /api/feedback - delivery outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.EnableFeedBackToSlack = false;
    mockSettings.EnableFeedBackToEmail = false;
    mockSettings.FeedbackReceiveEmail = '';
    mockSettings.FeedbackReceiveEmailNonProd = '';
    mockConfig.STAGE = 'production';
    mockPostFeedbackToSlack.mockResolvedValue({ outcome: 'delivered' });
    mockEmailPublish.mockResolvedValue(undefined);
  });

  it('does not call postFeedbackToSlack when EnableFeedBackToSlack is off, and reports it skipped', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockPostFeedbackToSlack).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.delivery.channels.slack).toEqual({ outcome: 'skipped', reason: 'disabled' });
  });

  it('batches the Slack and email disabled-skip metrics into one emitFeedbackDeliveryMetrics call', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
    const [metrics] = mockEmitMetrics.mock.calls[0];
    const channels = metrics.map((m: { dimensions?: { channel?: string } }) => m.dimensions?.channel).filter(Boolean);
    expect(channels).toEqual(expect.arrayContaining(['slack', 'email']));
  });

  it('calls postFeedbackToSlack once when enabled and reports its outcome verbatim', async () => {
    mockSettings.EnableFeedBackToSlack = true;
    mockPostFeedbackToSlack.mockResolvedValue({ outcome: 'skipped', reason: 'unconfigured_webhook' });
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockPostFeedbackToSlack).toHaveBeenCalledTimes(1);
    const body = res._getJSONData();
    expect(body.delivery.channels.slack).toEqual({ outcome: 'skipped', reason: 'unconfigured_webhook' });
  });

  it('reports delivered:true via Slack alone when it is the only channel that actually fires', async () => {
    mockSettings.EnableFeedBackToSlack = true;
    mockPostFeedbackToSlack.mockResolvedValue({ outcome: 'delivered' });
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.delivery.channels.slack).toEqual({ outcome: 'delivered' });
    expect(body.delivery.delivered).toBe(true);
  });

  it('does not publish email when EnableFeedBackToEmail is off, even with recipients configured', async () => {
    mockSettings.FeedbackReceiveEmail = 'team@example.com';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'skipped', reason: 'disabled' });
  });

  it('does not publish email when enabled but FeedbackReceiveEmail is empty', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = '';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'skipped', reason: 'no_recipients' });
  });

  it('trims comma-separated recipient addresses and publishes to each', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'a@x.com, b@x.com';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalledTimes(2);
    expect(mockEmailPublish.mock.calls[0][0].to).toBe('a@x.com');
    expect(mockEmailPublish.mock.calls[1][0].to).toBe('b@x.com');
  });

  it('treats a whitespace-only recipient list as no_recipients', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = ' , ';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'skipped', reason: 'no_recipients' });
  });

  it('reports delivered:false with a 201 status and the saved id when both channels are off (the default)', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    const body = res._getJSONData();
    expect(body.delivery.delivered).toBe(false);
    expect(body.id).toBe(savedFeedback.id);
  });

  it('logs at warn (not error) when both channels are deliberately disabled - not an incident', async () => {
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(Logger.warn).toHaveBeenCalled();
    expect(Logger.error).not.toHaveBeenCalled();
  });

  it('logs at error when Slack is enabled but the webhook is unconfigured - a real incident, not a deliberate choice', async () => {
    mockSettings.EnableFeedBackToSlack = true;
    mockPostFeedbackToSlack.mockResolvedValue({ outcome: 'skipped', reason: 'unconfigured_webhook' });
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(Logger.error).toHaveBeenCalled();
  });

  it('reports delivered:true via email even when Slack is skipped', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'team@example.com';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.delivery.delivered).toBe(true);
    expect(body.delivery.channels.email.outcome).toBe('delivered');
  });

  it('stays delivered:true when one of two email publishes rejects, and records a failure metric', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'a@x.com, b@x.com';
    mockEmailPublish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('smtp down'));
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.delivery.delivered).toBe(true);
    expect(body.delivery.channels.email.outcome).toBe('delivered');
    expect(mockRecordFailure).toHaveBeenCalledWith('email', 'production', 'publish_error', 'production');
  });

  it('logs the rejection reason for a partial email failure even though the channel outcome reports delivered', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'a@x.com, b@x.com';
    mockEmailPublish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('smtp down'));
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(Logger.error).toHaveBeenCalledWith(
      '[feedback] email publish rejected for one or more recipients',
      expect.objectContaining({
        succeeded: 1,
        attempted: 2,
        failedRecipients: ['b@x.com'],
        reasons: ['Error: smtp down'],
      })
    );
  });

  it('logs the rejection reasons and every failed recipient when every email publish rejects', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'a@x.com, b@x.com';
    mockEmailPublish.mockRejectedValue(new Error('smtp down'));
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(Logger.error).toHaveBeenCalledWith(
      '[feedback] email publish rejected for one or more recipients',
      expect.objectContaining({
        succeeded: 0,
        attempted: 2,
        failedRecipients: ['a@x.com', 'b@x.com'],
        reasons: ['Error: smtp down', 'Error: smtp down'],
      })
    );
  });

  it('reports email failed and delivered:false when Slack is off and every publish rejects', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'a@x.com, b@x.com';
    mockEmailPublish.mockRejectedValue(new Error('smtp down'));
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'failed', reason: 'error' });
    expect(body.delivery.delivered).toBe(false);
  });

  it('sends only to FeedbackReceiveEmail on a production stage', async () => {
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'prod-team@example.com';
    mockSettings.FeedbackReceiveEmailNonProd = 'staging-team@example.com';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalledTimes(1);
    expect(mockEmailPublish.mock.calls[0][0].to).toBe('prod-team@example.com');
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'delivered' });
  });

  it('sends only to FeedbackReceiveEmailNonProd on a non-production stage', async () => {
    mockConfig.STAGE = 'pr-1234';
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'prod-team@example.com';
    mockSettings.FeedbackReceiveEmailNonProd = 'staging-team@example.com';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).toHaveBeenCalledTimes(1);
    expect(mockEmailPublish.mock.calls[0][0].to).toBe('staging-team@example.com');
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'delivered' });
  });

  it('never falls back to FeedbackReceiveEmail when a non-production stage has no non-prod address set, and logs at warn not error', async () => {
    mockConfig.STAGE = 'pr-1234';
    mockSettings.EnableFeedBackToEmail = true;
    mockSettings.FeedbackReceiveEmail = 'prod-team@example.com';
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockEmailPublish).not.toHaveBeenCalled();
    const body = res._getJSONData();
    expect(body.delivery.channels.email).toEqual({ outcome: 'skipped', reason: 'nonprod_unconfigured' });
    expect(Logger.warn).toHaveBeenCalled();
    expect(Logger.error).not.toHaveBeenCalled();
  });
});
