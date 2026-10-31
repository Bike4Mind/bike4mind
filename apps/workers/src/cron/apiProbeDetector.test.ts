import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';

const mocks = vi.hoisted(() => ({
  resource: { App: { stage: 'production' } },
  connect: vi.fn(),
  settings: {} as Record<string, unknown>,
  claimed: new Set<string>(),
  claimDedup: vi.fn(),
  deleteByKey: vi.fn(),
  findLinkStatesByIds: vi.fn(),
  post: vi.fn(),
  runQuery: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  adminSettingsRepository: {},
  cacheRepository: { claimDedup: mocks.claimDedup, deleteByKey: mocks.deleteByKey },
  userRepository: { findLinkStatesByIds: mocks.findLinkStatesByIds },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => mocks.settings),
  getSettingsValue: (name: string, settings: Record<string, unknown>, fallback: unknown) => settings[name] ?? fallback,
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlackWithOutcome: mocks.post }));
vi.mock('../utils/logsInsights', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/logsInsights')>()),
  runLogsInsightsQuery: mocks.runQuery,
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return { log: mocks.log, error: mocks.error };
    }
  },
}));

import { formatProbeAlert, handler, probeDedupeKeys } from './apiProbeDetector';
import type { ProbeActor } from './apiProbeScoring';

const event = { time: '2026-10-30T12:00:00Z' };

const raw = (fields: Record<string, string>): ResultField[] =>
  Object.entries(fields).map(([field, value]) => ({ field, value }));

/** One IP driving one account: 3 refused fetches and 1 invalid id, 32 points. */
const probingRows = (ip = '203.0.113.10') => [
  raw({ ip, uid: 'user-a', refusedFetch: '3', invalidId: '1', paths: '4', firstPath: '/api/tools/web-fetch' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('API_SERVER_LOG_GROUP', '/aws/lambda/server');
  vi.stubEnv('SERVER_DOMAIN', 'example.com');
  mocks.resource.App.stage = 'production';
  mocks.settings = {};
  mocks.claimed.clear();
  mocks.claimDedup.mockImplementation(async (key: string) => {
    if (mocks.claimed.has(key)) return { claimed: false };
    mocks.claimed.add(key);
    return { claimed: true };
  });
  mocks.deleteByKey.mockImplementation(async (key: string) => {
    mocks.claimed.delete(key);
  });
  mocks.findLinkStatesByIds.mockResolvedValue([
    { id: 'user-a', createdAt: new Date('2026-10-30T09:00:00Z'), isBanned: false },
  ]);
  mocks.post.mockResolvedValue('sent');
  mocks.runQuery.mockResolvedValue(probingRows());
});

describe('apiProbeDetector handler', () => {
  it('posts one Security alert for an actor over the threshold', async () => {
    const result = await handler(event);

    expect(result).toMatchObject({ status: 'ok', actors: 1, alerted: 1, suppressed: 0 });
    expect(mocks.runQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        logGroup: '/aws/lambda/server',
        window: { start: new Date('2026-10-30T11:45:00Z'), end: new Date('2026-10-30T12:00:00Z') },
      })
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][1]).toBe('SlackSecurityAlertsWebhookUrl');
  });

  it('pages an actor at most once inside the dedupe window', async () => {
    await handler(event);
    const second = await handler({ time: '2026-10-30T12:05:00Z' });

    expect(second).toMatchObject({ alerted: 0, suppressed: 1 });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.claimDedup).toHaveBeenCalledWith(
      expect.stringMatching(/^api-probe-alert:user:user-a$/),
      expect.anything(),
      6 * 3_600_000
    );
  });

  it('pages again when a known account shows up from a new IP', async () => {
    await handler(event);
    mocks.runQuery.mockResolvedValue(probingRows('198.51.100.7'));
    const second = await handler({ time: '2026-10-30T12:05:00Z' });

    expect(second).toMatchObject({ alerted: 1 });
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('stays quiet below the admin threshold', async () => {
    mocks.settings = { probeDetectorScoreThreshold: 33 };
    const result = await handler(event);

    expect(result).toMatchObject({ actors: 0, alerted: 0 });
    expect(mocks.claimDedup).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('scans the admin-configured window', async () => {
    mocks.settings = { probeDetectorWindowMinutes: 30 };
    await handler(event);
    expect(mocks.runQuery.mock.calls[0][0].window.start).toEqual(new Date('2026-10-30T11:30:00Z'));
  });

  it('releases its claims when the Slack post fails, so the next run retries', async () => {
    mocks.post.mockResolvedValueOnce('failed');
    const first = await handler(event);
    expect(first).toMatchObject({ alerted: 0 });
    expect(mocks.claimed.size).toBe(0);

    const retry = await handler({ time: '2026-10-30T12:05:00Z' });
    expect(retry).toMatchObject({ alerted: 1 });
  });

  it('keeps its claims when security alerts are unconfigured', async () => {
    mocks.post.mockResolvedValueOnce('unconfigured');
    await handler(event);
    expect(mocks.deleteByKey).not.toHaveBeenCalled();
  });

  it('caps the posts of one run', async () => {
    mocks.runQuery.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => raw({ ip: `192.0.2.${index + 1}`, refusedFetch: '3' }))
    );
    const result = await handler(event);
    expect(result).toMatchObject({ actors: 7, alerted: 5, deferred: 2 });
  });

  it('does nothing when switched off in admin settings', async () => {
    mocks.settings = { probeDetectorEnabled: false };
    expect(await handler(event)).toEqual({ status: 'skipped', reason: 'disabled in admin settings' });
    expect(mocks.runQuery).not.toHaveBeenCalled();
  });

  it('skips non-production stages before touching the database', async () => {
    mocks.resource.App.stage = 'dev';
    expect(await handler(event)).toMatchObject({ status: 'skipped' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('fails loudly without its log group', async () => {
    vi.stubEnv('API_SERVER_LOG_GROUP', '');
    await expect(handler(event)).rejects.toThrow('API_SERVER_LOG_GROUP is not set');
  });
});

describe('probeDedupeKeys', () => {
  it('hashes IPs and keys accounts by id', () => {
    const keys = probeDedupeKeys({ ips: ['203.0.113.10'], userIds: ['user-a'] });
    expect(keys[0]).toMatch(/^api-probe-alert:ip:[0-9a-f]{32}$/);
    expect(keys[0]).not.toContain('203.0.113.10');
    expect(keys[1]).toBe('api-probe-alert:user:user-a');
  });
});

describe('formatProbeAlert', () => {
  const actor: ProbeActor = {
    ips: ['203.0.113.10'],
    userIds: ['user-a', 'user-gone'],
    score: 42,
    counts: { refusedFetch: 3, webhookSignature: 0, invalidId: 6, denied: 0, notFound: 0 },
    distinctPaths: 14,
    samplePaths: ['/api/tools/web-fetch', '/api/<x>'],
  };
  const window = { start: new Date('2026-10-30T11:45:00Z'), end: new Date('2026-10-30T12:00:00Z') };

  it('lists signals, accounts with age and admin link, IPs and escaped sample paths', () => {
    const text = formatProbeAlert({
      actor,
      users: new Map([
        ['user-a', { id: 'user-a', createdAt: new Date('2026-10-30T09:00:00Z'), isBanned: true }],
      ]) as never,
      threshold: 25,
      window,
      stage: 'production',
      appUrl: 'https://app.example.com',
    });

    expect(text).toContain('Score 42 (threshold 25)');
    expect(text).toContain('- 3 refused fetch targets');
    expect(text).toContain('- 6 invalid-id lookups');
    expect(text).not.toContain('404s');
    expect(text).toContain(
      '`user-a` - <https://app.example.com/admin/users/user-a|Open in admin> (3 h old, already banned)'
    );
    expect(text).toContain('`user-gone`');
    expect(text).toContain('(no such account)');
    expect(text).toContain('`203.0.113.10`');
    expect(text).toContain('/api/&lt;x&gt;');
    expect(text).toContain('bulk Contain');
  });

  it('omits the contain hint for an anonymous actor', () => {
    const text = formatProbeAlert({
      actor: { ...actor, userIds: [] },
      users: new Map(),
      threshold: 25,
      window,
      stage: 'production',
      appUrl: undefined,
    });
    expect(text).toContain('- none signed in');
    expect(text).not.toContain('bulk Contain');
  });
});
