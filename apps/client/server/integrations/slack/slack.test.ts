import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET_FALLBACK = 'https://hooks.slack.com/services/secret-fallback';

// Mutable holder so individual tests can vary the SST-backed secret fallback
// (including the defensive case where SST never injected a value).
const mocks = vi.hoisted(() => ({ config: { SLACK_WEBHOOK_URL: '' as string | undefined } }));

// Mock the SST-backed Config so the test never touches `Resource`.
vi.mock('@server/utils/config', () => ({ Config: mocks.config }));

// Mirror the real settings parsing: return the stored value or '' (the default for these string settings).
// slack.ts imports only getSettingsMap/getSettingsValue from @bike4mind/utils.
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(),
  getSettingsValue: (key: string, settings: Record<string, string>) => settings[key] ?? '',
}));

// slack.ts imports adminSettingsRepository from the database barrel; stub it so the
// pure resolveSlackWebhookUrl test doesn't load the full model graph.
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
}));

// Match the canonical helper from @bike4mind/common (same approach as mailer/index.test.ts).
vi.mock('@bike4mind/common', () => ({
  isPlaceholderValue: (value: string | undefined | null) => {
    if (!value) return true;
    const normalized = value.trim().toLowerCase();
    return normalized === 'my-secret-placeholder-value' || normalized === 'not-configured';
  },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { resolveSlackWebhookUrl } from './slack';

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
