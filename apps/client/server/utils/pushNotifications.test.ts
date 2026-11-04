import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('./eventBus', () => ({ NotificationEvents: { Push: { publish: h.publish } } }));
const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import {
  appRootDeepLink,
  hasLiveConnection,
  isWatchingConnection,
  publishPushNotification,
  sessionDeepLink,
  truncateForPush,
  type WatchedConnectionRow,
} from './pushNotifications';

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

const now = new Date('2026-01-01T12:00:00Z');
const inFuture = new Date(now.getTime() + 5 * 60_000);
const inPast = new Date(now.getTime() - 1);
const logger = { warn: vi.fn() };

function lookup(rows: WatchedConnectionRow[]) {
  return { findByUserId: vi.fn(async () => rows) };
}

describe('isWatchingConnection', () => {
  it('counts a web socket whose auth is still current', () => {
    expect(isWatchingConnection({ source: 'web', authExpiresAt: inFuture }, now)).toBe(true);
  });

  it.each<[string, WatchedConnectionRow]>([
    ['a CLI session', { source: 'cli', authExpiresAt: inFuture }],
    ['an API-key socket', { source: 'web', apiKeyId: 'key-1', authExpiresAt: inFuture }],
    ['a stale web row nobody reauthed', { source: 'web', authExpiresAt: inPast }],
    ['a web row expiring exactly now', { source: 'web', authExpiresAt: now }],
    ['a legacy row without authExpiresAt', { source: 'web' }],
    ['a row without a source', { authExpiresAt: inFuture }],
  ])('does not count %s', (_label, row) => {
    expect(isWatchingConnection(row, now)).toBe(false);
  });
});

describe('hasLiveConnection', () => {
  it('is false when only CLI and stale rows exist', async () => {
    const rows = lookup([
      { source: 'cli', authExpiresAt: inFuture },
      { source: 'web', authExpiresAt: inPast },
    ]);
    await expect(hasLiveConnection('user-1', rows, logger, now)).resolves.toBe(false);
  });

  it('is true when any row is a live web session', async () => {
    const rows = lookup([
      { source: 'cli', authExpiresAt: inFuture },
      { source: 'web', authExpiresAt: inFuture },
    ]);
    await expect(hasLiveConnection('user-1', rows, logger, now)).resolves.toBe(true);
  });

  it('fails toward pushing when the lookup throws', async () => {
    const rows = {
      findByUserId: vi.fn(async (): Promise<WatchedConnectionRow[]> => {
        throw new Error('db down');
      }),
    };
    await expect(hasLiveConnection('user-1', rows, logger, now)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});
