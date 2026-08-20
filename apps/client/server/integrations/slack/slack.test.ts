import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET_FALLBACK = 'https://hooks.slack.com/services/secret-fallback';

// Mutable holder so individual tests can vary the SST-backed secret fallback
// (including the defensive case where SST never injected a value) and the deploy stage.
const mocks = vi.hoisted(() => ({
  config: { SLACK_WEBHOOK_URL: '' as string | undefined, STAGE: 'production' as string | undefined },
  post: vi.fn(),
  getSettingsMap: vi.fn(),
}));

// Mock the SST-backed Config so the test never touches `Resource`.
vi.mock('@server/utils/config', () => ({
  Config: mocks.config,
}));

vi.mock('axios', () => ({
  default: { post: mocks.post, isAxiosError: (err: unknown) => !!(err as { isAxiosError?: boolean })?.isAxiosError },
  isAxiosError: (err: unknown) => !!(err as { isAxiosError?: boolean })?.isAxiosError,
}));

// Mirror the real settings parsing: return the stored value or '' (the default for these string settings).
// slack.ts imports only getSettingsMap/getSettingsValue from @bike4mind/utils.
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: mocks.getSettingsMap,
  getSettingsValue: (key: string, settings: Record<string, string>) => settings[key] ?? '',
}));

// slack.ts imports adminSettingsRepository from the database barrel; stub it so the
// pure resolveSlackWebhookUrl test doesn't load the full model graph.
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@server/utils/cloudwatch', () => ({
  recordFeedbackDeliverySuccess: vi.fn(),
  recordFeedbackDeliveryFailure: vi.fn(),
  recordFeedbackDeliverySkipped: vi.fn(),
}));

import { resolveSlackWebhookUrl, resolveFeedbackSlackRoute, postFeedbackToSlack } from './slack';
import { Logger } from '@bike4mind/observability';
import {
  recordFeedbackDeliverySuccess,
  recordFeedbackDeliveryFailure,
  recordFeedbackDeliverySkipped,
} from '@server/utils/cloudwatch';

describe('resolveSlackWebhookUrl', () => {
  const channelUrl = 'https://hooks.slack.com/services/channel';
  const defaultUrl = 'https://hooks.slack.com/services/default';

  beforeEach(() => {
    mocks.config.SLACK_WEBHOOK_URL = SECRET_FALLBACK;
  });

  it('prefers the channel-specific webhook URL over all fallbacks', () => {
    expect(
      resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', {
        SlackLiveopsWebhookUrl: channelUrl,
        SlackDefaultWebhookUrl: defaultUrl,
      })
    ).toBe(channelUrl);
  });

  it('falls back to SlackDefaultWebhookUrl when the channel URL is unset', () => {
    expect(resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', { SlackDefaultWebhookUrl: defaultUrl })).toBe(defaultUrl);
  });

  it('falls back to the SLACK_WEBHOOK_URL secret when no admin settings are configured', () => {
    expect(resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', {})).toBe(SECRET_FALLBACK);
  });

  it('returns an empty string when every source resolves to the unset placeholder', () => {
    mocks.config.SLACK_WEBHOOK_URL = 'not-configured';
    expect(resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', {})).toBe('');
  });

  it('trims surrounding whitespace from the resolved URL', () => {
    expect(resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', { SlackLiveopsWebhookUrl: `  ${channelUrl}  ` })).toBe(
      channelUrl
    );
  });

  it('treats a whitespace-only value as unconfigured and falls through', () => {
    expect(resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', { SlackLiveopsWebhookUrl: '   ' })).toBe(SECRET_FALLBACK);
  });

  it('returns an empty string without throwing when the secret was never injected', () => {
    mocks.config.SLACK_WEBHOOK_URL = undefined;
    expect(resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', {})).toBe('');
  });
});

describe('resolveFeedbackSlackRoute', () => {
  const feedbackUrl = 'https://hooks.slack.com/services/feedback';
  const defaultUrl = 'https://hooks.slack.com/services/default';
  const nonProdUrl = 'https://hooks.slack.com/services/nonprod-feedback';

  it('production stage with SlackFeedbackWebhookUrl set posts to the feedback channel', () => {
    expect(resolveFeedbackSlackRoute('production', { SlackFeedbackWebhookUrl: feedbackUrl })).toEqual({
      kind: 'post',
      webhookUrl: feedbackUrl,
      stageClass: 'production',
    });
  });

  it('production stage with only SlackDefaultWebhookUrl set still posts (fallback preserved)', () => {
    expect(resolveFeedbackSlackRoute('production', { SlackDefaultWebhookUrl: defaultUrl })).toEqual({
      kind: 'post',
      webhookUrl: defaultUrl,
      stageClass: 'production',
    });
  });

  it('production stage with nothing configured skips with unconfigured_webhook', () => {
    expect(resolveFeedbackSlackRoute('production', {})).toEqual({
      kind: 'skip',
      stageClass: 'production',
      reason: 'unconfigured_webhook',
    });
  });

  it.each(['staging', 'dev', 'pr-1234'])(
    '%s stage with a non-prod webhook configured posts to that webhook, not the prod channel',
    stage => {
      expect(
        resolveFeedbackSlackRoute(stage, {
          SlackNonProdFeedbackWebhookUrl: nonProdUrl,
          SlackFeedbackWebhookUrl: feedbackUrl,
          SlackDefaultWebhookUrl: defaultUrl,
        })
      ).toEqual({ kind: 'post', webhookUrl: nonProdUrl, stageClass: 'nonprod' });
    }
  );

  it('non-prod stage with the non-prod webhook unset never falls back to the prod channel', () => {
    const result = resolveFeedbackSlackRoute('pr-1234', {
      SlackFeedbackWebhookUrl: feedbackUrl,
      SlackDefaultWebhookUrl: defaultUrl,
    });
    expect(result).toEqual({ kind: 'skip', stageClass: 'nonprod', reason: 'nonprod_unconfigured' });
    expect(result).not.toHaveProperty('webhookUrl');
  });

  it('non-prod stage with a whitespace-only non-prod webhook skips the same way', () => {
    expect(resolveFeedbackSlackRoute('pr-1234', { SlackNonProdFeedbackWebhookUrl: '   ' })).toEqual({
      kind: 'skip',
      stageClass: 'nonprod',
      reason: 'nonprod_unconfigured',
    });
  });

  it('an undefined stage classifies as nonprod (fail-safe: never assume production)', () => {
    expect(resolveFeedbackSlackRoute(undefined, {})).toEqual({
      kind: 'skip',
      stageClass: 'nonprod',
      reason: 'nonprod_unconfigured',
    });
  });
});

describe('postFeedbackToSlack', () => {
  const args = ['Bug', 'Acme', 'jdoe', 'jdoe@example.com', 'user-1', 'it broke', 'No prompt meta'] as const;

  beforeEach(() => {
    mocks.config.STAGE = 'production';
    mocks.post.mockReset();
    mocks.post.mockResolvedValue({ status: 200 });
    vi.mocked(Logger.error).mockClear();
    vi.mocked(Logger.warn).mockClear();
    vi.mocked(recordFeedbackDeliverySuccess).mockClear();
    vi.mocked(recordFeedbackDeliveryFailure).mockClear();
    vi.mocked(recordFeedbackDeliverySkipped).mockClear();
  });

  it('posts to the feedback channel on production with a configured webhook', async () => {
    mocks.getSettingsMap.mockResolvedValue({ SlackFeedbackWebhookUrl: 'https://hooks.slack.com/services/feedback' });
    const result = await postFeedbackToSlack(...args);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/feedback');
    expect(body.text).toContain('*Type:* Bug');
    expect(recordFeedbackDeliverySuccess).toHaveBeenCalledWith('slack', 'production');
    expect(result).toEqual({ outcome: 'delivered' });
  });

  it('posts to the non-prod webhook (never the prod one) on a non-prod stage, with a stage marker', async () => {
    mocks.config.STAGE = 'pr-1234';
    mocks.getSettingsMap.mockResolvedValue({
      SlackNonProdFeedbackWebhookUrl: 'https://hooks.slack.com/services/nonprod',
      SlackFeedbackWebhookUrl: 'https://hooks.slack.com/services/feedback',
    });
    await postFeedbackToSlack(...args);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/nonprod');
    expect(body.text).toContain('*[pr-1234]*');
    expect(recordFeedbackDeliverySuccess).toHaveBeenCalledWith('slack', 'nonprod');
  });

  it('does not post when the non-prod stage has no non-prod webhook configured', async () => {
    mocks.config.STAGE = 'pr-1234';
    mocks.getSettingsMap.mockResolvedValue({ SlackFeedbackWebhookUrl: 'https://hooks.slack.com/services/feedback' });
    const result = await postFeedbackToSlack(...args);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(recordFeedbackDeliverySkipped).toHaveBeenCalledWith('slack', 'nonprod', 'nonprod_unconfigured', 'pr-1234');
    expect(result).toEqual({ outcome: 'skipped', reason: 'nonprod_unconfigured' });
  });

  it('records a skip with unconfigured_webhook when production has no webhook configured', async () => {
    mocks.getSettingsMap.mockResolvedValue({});
    const result = await postFeedbackToSlack(...args);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(recordFeedbackDeliverySkipped).toHaveBeenCalledWith(
      'slack',
      'production',
      'unconfigured_webhook',
      'production'
    );
    expect(result).toEqual({ outcome: 'skipped', reason: 'unconfigured_webhook' });
  });

  it('still posts on production even when NODE_ENV is not "production" (the removed early-return regression check)', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      mocks.getSettingsMap.mockResolvedValue({ SlackFeedbackWebhookUrl: 'https://hooks.slack.com/services/feedback' });
      await postFeedbackToSlack(...args);
      expect(mocks.post).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('resolves without throwing on a network-level rejection, logs the error, and records a "network" failure metric', async () => {
    mocks.getSettingsMap.mockResolvedValue({ SlackFeedbackWebhookUrl: 'https://hooks.slack.com/services/feedback' });
    mocks.post.mockRejectedValue(Object.assign(new Error('network down'), { isAxiosError: true }));
    const result = await postFeedbackToSlack(...args);
    expect(Logger.error).toHaveBeenCalled();
    expect(recordFeedbackDeliveryFailure).toHaveBeenCalledWith('slack', 'production', 'network', 'production');
    expect(result).toEqual({ outcome: 'failed', reason: 'error' });
  });

  it('records an "unknown" failure metric when the rejection is not an axios error', async () => {
    mocks.getSettingsMap.mockResolvedValue({ SlackFeedbackWebhookUrl: 'https://hooks.slack.com/services/feedback' });
    mocks.post.mockRejectedValue(new Error('unexpected'));
    const result = await postFeedbackToSlack(...args);
    expect(recordFeedbackDeliveryFailure).toHaveBeenCalledWith('slack', 'production', 'unknown', 'production');
    expect(result).toEqual({ outcome: 'failed', reason: 'error' });
  });

  it('records the HTTP status as the failure errorType when the axios error carries a response', async () => {
    mocks.getSettingsMap.mockResolvedValue({ SlackFeedbackWebhookUrl: 'https://hooks.slack.com/services/feedback' });
    mocks.post.mockRejectedValue(
      Object.assign(new Error('bad request'), { isAxiosError: true, response: { status: 400 } })
    );
    const result = await postFeedbackToSlack(...args);
    expect(recordFeedbackDeliveryFailure).toHaveBeenCalledWith('slack', 'production', '400', 'production');
    expect(result).toEqual({ outcome: 'failed', reason: 'error' });
  });

  it('records a failure metric when the settings load itself rejects (e.g. a Mongo timeout), before any route is resolved', async () => {
    mocks.getSettingsMap.mockRejectedValue(new Error('mongo timeout'));
    const result = await postFeedbackToSlack(...args);
    expect(recordFeedbackDeliveryFailure).toHaveBeenCalledWith('slack', 'production', 'unhandled', 'production');
    expect(result).toEqual({ outcome: 'failed', reason: 'error' });
  });

  it('the non-prod stage marker never touches the redacted Prompt Meta section', async () => {
    mocks.config.STAGE = 'pr-1234';
    mocks.getSettingsMap.mockResolvedValue({
      SlackNonProdFeedbackWebhookUrl: 'https://hooks.slack.com/services/nonprod',
    });
    await postFeedbackToSlack('Bug', 'Acme', 'jdoe', 'jdoe@example.com', 'user-1', 'it broke', 'REDACTED_BLOB');
    const [, body] = mocks.post.mock.calls[0];
    const promptMetaSection = body.text.split('*Prompt Meta:*')[1];
    expect(promptMetaSection).toContain('REDACTED_BLOB');
    expect(promptMetaSection).not.toContain('[pr-1234]');
  });
});
