import { describe, it, expect, vi } from 'vitest';

/**
 * Mirrors slack.test.ts's resolveFeedbackSlackRoute coverage one-for-one: the email channel must
 * make the same production/non-production split, and non-prod must never fall back to the
 * production recipient list (that fallback is the exact stage-leak bug this resolver closes).
 */

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = { get: () => chain, post: () => chain };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({ FeedbackModel: {}, User: {}, adminSettingsRepository: {} }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/integrations/slack/slack', () => ({ postFeedbackToSlack: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(),
  getSettingsValue: (key: string, settings: Record<string, string>) => settings[key],
}));
vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'production' },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordFeedbackDeliverySuccess: vi.fn(),
  recordFeedbackDeliveryFailure: vi.fn(),
  recordFeedbackDeliverySkipped: vi.fn(),
  ALARM_WORTHY_SKIP_REASONS: ['unconfigured_webhook', 'no_recipients'],
}));

import { resolveFeedbackEmailRoute } from '../index';

describe('resolveFeedbackEmailRoute', () => {
  const prodEmail = 'prod-team@example.com';
  const nonProdEmail = 'staging-team@example.com';

  it('production stage with FeedbackReceiveEmail set sends to that list', () => {
    expect(resolveFeedbackEmailRoute('production', { FeedbackReceiveEmail: prodEmail })).toEqual({
      kind: 'send',
      recipients: [prodEmail],
      stageClass: 'production',
    });
  });

  it('production stage with FeedbackReceiveEmail unset skips with no_recipients', () => {
    expect(resolveFeedbackEmailRoute('production', {})).toEqual({
      kind: 'skip',
      stageClass: 'production',
      reason: 'no_recipients',
    });
  });

  it.each(['staging', 'dev', 'pr-1234'])(
    '%s stage with FeedbackReceiveEmailNonProd configured sends to that list, not the prod list',
    stage => {
      expect(
        resolveFeedbackEmailRoute(stage, {
          FeedbackReceiveEmailNonProd: nonProdEmail,
          FeedbackReceiveEmail: prodEmail,
        })
      ).toEqual({ kind: 'send', recipients: [nonProdEmail], stageClass: 'nonprod' });
    }
  );

  it('non-prod stage with the non-prod list unset never falls back to the prod list', () => {
    const result = resolveFeedbackEmailRoute('pr-1234', { FeedbackReceiveEmail: prodEmail });
    expect(result).toEqual({ kind: 'skip', stageClass: 'nonprod', reason: 'nonprod_unconfigured' });
    expect(result).not.toHaveProperty('recipients');
  });

  it('non-prod stage with a whitespace-only non-prod list skips the same way', () => {
    expect(resolveFeedbackEmailRoute('pr-1234', { FeedbackReceiveEmailNonProd: '   ' })).toEqual({
      kind: 'skip',
      stageClass: 'nonprod',
      reason: 'nonprod_unconfigured',
    });
  });

  it('an undefined stage classifies as nonprod (fail-safe: never assume production)', () => {
    expect(resolveFeedbackEmailRoute(undefined, {})).toEqual({
      kind: 'skip',
      stageClass: 'nonprod',
      reason: 'nonprod_unconfigured',
    });
  });

  it('trims a comma-separated list and drops blank entries, on both prod and non-prod paths', () => {
    expect(resolveFeedbackEmailRoute('production', { FeedbackReceiveEmail: ' a@x.com,  ,b@x.com ,' })).toEqual({
      kind: 'send',
      recipients: ['a@x.com', 'b@x.com'],
      stageClass: 'production',
    });

    expect(resolveFeedbackEmailRoute('staging', { FeedbackReceiveEmailNonProd: ' c@x.com, ,d@x.com ' })).toEqual({
      kind: 'send',
      recipients: ['c@x.com', 'd@x.com'],
      stageClass: 'nonprod',
    });
  });
});
