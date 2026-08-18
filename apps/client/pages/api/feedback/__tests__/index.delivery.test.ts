import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Each of the four independent delivery gates (EnableFeedBackToSlack, EnableFeedBackToEmail +
 * a non-empty FeedbackReceiveEmail, the webhook-URL configuration, and the deploy-stage routing)
 * must fail or succeed on its own without the submitter being told delivery succeeded when no
 * channel actually fired. The stage-routing gate itself is covered independently in slack.test.ts;
 * this file covers the route's aggregation of postFeedbackToSlack's reported outcome plus the
 * email path, which the route owns directly.
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
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn((key: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mockSettings as any)[key];
  }),
}));

vi.mock('@server/utils/config', () => ({ Config: { STAGE: 'production' } }));

vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const mockRecordSuccess = vi.fn();
const mockRecordFailure = vi.fn();
const mockRecordSkipped = vi.fn();
vi.mock('@server/utils/cloudwatch', () => ({
  recordFeedbackDeliverySuccess: (...args: unknown[]) => mockRecordSuccess(...args),
  recordFeedbackDeliveryFailure: (...args: unknown[]) => mockRecordFailure(...args),
  recordFeedbackDeliverySkipped: (...args: unknown[]) => mockRecordSkipped(...args),
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

describe('POST /api/feedback - delivery outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.EnableFeedBackToSlack = false;
    mockSettings.EnableFeedBackToEmail = false;
    mockSettings.FeedbackReceiveEmail = '';
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

  it('calls postFeedbackToSlack once when enabled and reports its outcome verbatim', async () => {
    mockSettings.EnableFeedBackToSlack = true;
    mockPostFeedbackToSlack.mockResolvedValue({ outcome: 'skipped', reason: 'unconfigured_webhook' });
    const { req, res } = run();
    await mockRefs.postHandler!(req, res);

    expect(mockPostFeedbackToSlack).toHaveBeenCalledTimes(1);
    const body = res._getJSONData();
    expect(body.delivery.channels.slack).toEqual({ outcome: 'skipped', reason: 'unconfigured_webhook' });
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
    expect(mockRecordFailure).toHaveBeenCalledWith('email', 'production', 'publish_error');
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
});
