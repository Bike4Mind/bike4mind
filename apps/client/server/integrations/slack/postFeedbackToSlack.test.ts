import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPost = vi.fn();
const mockGetSettingsMap = vi.fn();
const mockGetSettingsValue = vi.fn();

vi.mock('axios', () => ({
  default: { post: (...args: unknown[]) => mockPost(...args) },
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => mockGetSettingsMap(...args),
  getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));

vi.mock('@bike4mind/observability', () => ({
  Logger: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@bike4mind/common', () => ({ isPlaceholderValue: () => false }));

vi.mock('@server/utils/config', () => ({ Config: {} }));

vi.mock('./emailMirror', () => ({ buildEmailMirrorMessage: vi.fn() }));

import { postFeedbackToSlack } from './slack';

const WEBHOOK = 'https://hooks.slack.example/T000/B000/xxx';

const callWithFeedback = () =>
  postFeedbackToSlack('BUG', 'Acme', 'someone', 'someone@example.com', 'user-1', 'the answer was wrong', '{}');

describe('postFeedbackToSlack', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsMap.mockResolvedValue({});
    mockGetSettingsValue.mockReturnValue(WEBHOOK);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('reports delivered when the webhook accepts the post', async () => {
    mockPost.mockResolvedValue({ status: 200 });

    await expect(callWithFeedback()).resolves.toEqual({ status: 'delivered' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('reports skipped, not delivered, when no webhook is configured', async () => {
    mockGetSettingsValue.mockReturnValue(undefined);

    await expect(callWithFeedback()).resolves.toEqual({
      status: 'skipped',
      reason: 'no_webhook_configured',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('reports failed instead of swallowing a transport error', async () => {
    mockPost.mockRejectedValue(new Error('channel_not_found'));

    await expect(callWithFeedback()).resolves.toEqual({
      status: 'failed',
      reason: 'channel_not_found',
    });
  });

  // Regression guard. This function used to return early unless NODE_ENV === 'production', which
  // made delivery unverifiable anywhere except production while doing nothing to keep stages apart
  // (deployed stages run a production build regardless). Stage separation comes from admin settings
  // being per-stage, so re-adding an environment gate here would silently break non-prod delivery.
  it.each(['development', 'test', undefined])('posts when NODE_ENV is %s', async nodeEnv => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    mockPost.mockResolvedValue({ status: 200 });

    await expect(callWithFeedback()).resolves.toEqual({ status: 'delivered' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
