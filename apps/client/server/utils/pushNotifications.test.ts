import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('./eventBus', () => ({ NotificationEvents: { Push: { publish: h.publish } } }));
const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import { appRootDeepLink, publishPushNotification, sessionDeepLink, truncateForPush } from './pushNotifications';

const event = {
  userId: 'user-1',
  category: 'chat_completed' as const,
  title: 'T',
  body: 'B',
  deepLink: '/notebooks/s1',
};

describe('deep links', () => {
  const saved = process.env.APP_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  });

  it("points at the web app's notebook route, absolute when APP_URL is set", () => {
    process.env.APP_URL = 'https://app.example.test/';
    expect(sessionDeepLink('abc')).toBe('https://app.example.test/notebooks/abc');
    expect(appRootDeepLink()).toBe('https://app.example.test');
  });

  it('is path-only without APP_URL', () => {
    delete process.env.APP_URL;
    expect(sessionDeepLink('a/b')).toBe('/notebooks/a%2Fb');
    expect(appRootDeepLink()).toBe('/');
  });
});

describe('publishPushNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushDelivery.configured = true;
  });

  it('publishes nothing while push delivery is unconfigured', async () => {
    pushDelivery.configured = false;
    const logger = { warn: vi.fn() };
    await publishPushNotification(event, logger);
    expect(h.publish).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('publishes a valid event', async () => {
    await publishPushNotification(event, { warn: vi.fn() });
    expect(h.publish).toHaveBeenCalledWith(event);
  });

  it('logs and swallows a publish failure', async () => {
    h.publish.mockRejectedValueOnce(new Error('bus down'));
    const logger = { warn: vi.fn() };
    await expect(publishPushNotification(event, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('[Push] failed to publish push notification', expect.any(Object));
  });

  it('refuses an invalid event without publishing', async () => {
    const logger = { warn: vi.fn() };
    await publishPushNotification({ ...event, category: 'nope' as never }, logger);
    expect(h.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('truncateForPush', () => {
  it('keeps short text and ellipsizes long text to the limit', () => {
    expect(truncateForPush('short', 10)).toBe('short');
    expect(truncateForPush('abcdefghijkl', 8)).toBe('abcde...');
  });
});
