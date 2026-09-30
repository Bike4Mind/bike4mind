import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { config, mockPost } = vi.hoisted(() => ({
  config: { QA_ALARM_SLACK_WEBHOOKS: undefined as string | undefined },
  mockPost: vi.fn(),
}));
vi.mock('@server/utils/config', () => ({ Config: config }));
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => mockPost(...a) } }));

import { defaultAlarmDeps, parseWebhookMap } from './evaluateAlarm';

describe('parseWebhookMap', () => {
  it('keeps https entries and drops everything else', () => {
    expect(parseWebhookMap('{"product-a":"https://hooks.example.com/a","product-b":"http://x","product-c":3}')).toEqual(
      { 'product-a': 'https://hooks.example.com/a' }
    );
  });
  it('is empty for unset, placeholder, non-object and invalid JSON', () => {
    expect(parseWebhookMap(undefined)).toEqual({});
    expect(parseWebhookMap('not-configured')).toEqual({});
    expect(parseWebhookMap('["https://hooks.example.com/a"]')).toEqual({});
    expect(parseWebhookMap('null')).toEqual({});
    expect(parseWebhookMap('{nope')).toEqual({});
  });
});

describe('defaultAlarmDeps', () => {
  const log = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    config.QA_ALARM_SLACK_WEBHOOKS = '{"product-a":"https://hooks.example.com/a"}';
    vi.stubEnv('APP_URL', 'https://app.example.com/');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('looks the webhook up by product slug from the secret', () => {
    const deps = defaultAlarmDeps(log);
    expect(deps.webhookFor('product-a')).toBe('https://hooks.example.com/a');
    expect(deps.webhookFor('product-b')).toBeUndefined();
    // Slugs are free-form, so an Object.prototype key must not resolve to a function.
    expect(deps.webhookFor('constructor')).toBeUndefined();
  });
  it('uses APP_URL without a trailing slash as the link origin', () => {
    expect(defaultAlarmDeps(log).appOrigin).toBe('https://app.example.com');
  });
  it('posts the text to the webhook with a timeout', async () => {
    mockPost.mockResolvedValue({ status: 200 });
    await defaultAlarmDeps(log).post('https://hooks.example.com/a', 'hello');
    expect(mockPost).toHaveBeenCalledWith('https://hooks.example.com/a', { text: 'hello' }, { timeout: 5000 });
  });
  it('propagates a Slack failure to the caller', async () => {
    mockPost.mockRejectedValue(new Error('500'));
    await expect(defaultAlarmDeps(log).post('https://hooks.example.com/a', 'hello')).rejects.toThrow('500');
  });
  it('is log-only, and says so, when the secret is set but unusable', () => {
    config.QA_ALARM_SLACK_WEBHOOKS = '{nope';
    const deps = defaultAlarmDeps(log);
    expect(deps.webhookFor('product-a')).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no usable https entries'));
  });
  it('stays quiet when the secret is the placeholder', () => {
    config.QA_ALARM_SLACK_WEBHOOKS = 'not-configured';
    expect(defaultAlarmDeps(log).webhookFor('product-a')).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
