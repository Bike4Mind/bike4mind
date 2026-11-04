import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { EventBridgeEvent } from 'aws-lambda';
import type { PushNotificationEvent } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  withEventContextInner: vi.fn(),
  findByUser: vi.fn(),
  removeByToken: vi.fn(),
  removeBySids: vi.fn(),
  findLiveSids: vi.fn(),
  userFindById: vi.fn(),
  orgFindById: vi.fn(),
}));

vi.mock('@workers/utils/eventContext', () => ({
  withEventContext: (inner: unknown) => {
    h.withEventContextInner.mockImplementation(inner as never);
    return async (event: EventBridgeEvent<string, unknown>) =>
      h.withEventContextInner(
        { event: event['detail-type'], properties: event.detail },
        {
          info: vi.fn(),
          warn: vi.fn(),
          updateMetadata: vi.fn(),
        }
      );
  },
}));

vi.mock('@server/utils/eventBus', async () => {
  const { PushNotificationEventSchema } = await import('@bike4mind/common');
  return { NotificationEvents: { Push: { schema: PushNotificationEventSchema } } };
});

vi.mock('@bike4mind/database', () => ({
  pushTokenRepository: { findByUser: h.findByUser, removeByToken: h.removeByToken, removeBySids: h.removeBySids },
  authSessionRepository: { findLiveSids: h.findLiveSids },
  userRepository: { findById: h.userFindById },
  organizationRepository: { findById: h.orgFindById },
}));

import { deliverPush, handler, loadPushRecipient, REDACTED_PUSH_COPY, type SendPushDeps } from './sendPush';
import type { ApnsRequest, ApnsResponse } from './sendPush.apns';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const EVENT: PushNotificationEvent = {
  userId: '507f1f77bcf86cd799439011',
  category: 'agent_completed',
  title: 'Agent finished',
  body: 'Your agent finished its task in "Q3 plan".',
  deepLink: '/notebooks/session-1',
  collapseId: 'agent-run:exec-1',
  questId: 'quest-1',
  sessionId: 'session-1',
};

type Token = { token: string; environment: 'sandbox' | 'production'; sid?: string };

function makeDeps(
  tokens: Token[],
  overrides: Partial<SendPushDeps> & {
    respond?: (request: ApnsRequest) => ApnsResponse;
    endedSids?: readonly string[];
  } = {}
) {
  const sent: ApnsRequest[] = [];
  const removed: string[] = [];
  const removedSids: string[] = [];
  const endedSids = new Set(overrides.endedSids ?? []);
  const stored = tokens.map(token => ({ sid: 'sid-live', ...token }));
  const deps: SendPushDeps = {
    tokens: {
      findByUser: vi.fn(async () => stored),
      removeByToken: vi.fn(async (token: string) => {
        removed.push(token);
        return true;
      }),
      removeBySids: vi.fn(async (sids: readonly string[]) => {
        removedSids.push(...sids);
        return stored.filter(token => sids.includes(token.sid)).length;
      }),
    },
    sessions: {
      findLiveSids: vi.fn(async (sids: readonly string[]) => new Set(sids.filter(sid => !endedSids.has(sid)))),
    },
    loadRecipient: vi.fn(async () => ({ preferences: undefined, redactContent: false })),
    transport: {
      send: vi.fn(async (request: ApnsRequest) => {
        sent.push(request);
        return overrides.respond?.(request) ?? { status: 200 };
      }),
      close: vi.fn(),
    },
    topic: 'com.example.client',
    appUrl: 'https://app.example.test',
    ...overrides,
  };
  return { deps, sent, removed, removedSids };
}

const payloadOf = (request: ApnsRequest) => JSON.parse(request.payload);

describe('deliverPush', () => {
  beforeEach(() => vi.clearAllMocks());

  it('succeeds without contacting APNs or reading the user when there are no device tokens', async () => {
    const { deps } = makeDeps([]);

    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({ status: 'skipped', reason: 'no_tokens' });
    expect(deps.tokens.findByUser).toHaveBeenCalledWith(EVENT.userId, 'device');
    expect(deps.loadRecipient).not.toHaveBeenCalled();
    expect(deps.transport.send).not.toHaveBeenCalled();
    expect(deps.sessions.findLiveSids).not.toHaveBeenCalled();
  });

  it('prunes and skips tokens whose session has ended, delivering only to live sessions', async () => {
    const { deps, sent, removedSids } = makeDeps(
      [
        { token: 'tok-live', environment: 'production', sid: 'sid-live' },
        { token: 'tok-expired-a', environment: 'production', sid: 'sid-expired' },
        { token: 'tok-expired-b', environment: 'sandbox', sid: 'sid-expired' },
      ],
      { endedSids: ['sid-expired'] }
    );

    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({
      status: 'sent',
      delivered: 1,
      pruned: 2,
      failed: 0,
    });
    expect(deps.sessions.findLiveSids).toHaveBeenCalledTimes(1);
    expect(deps.sessions.findLiveSids).toHaveBeenCalledWith(['sid-live', 'sid-expired']);
    expect(removedSids).toEqual(['sid-expired']);
    expect(sent.map(request => request.deviceToken)).toEqual(['tok-live']);
  });

  it('skips without reading the user when every token belongs to an ended session', async () => {
    const { deps, removedSids } = makeDeps([{ token: 'tok-a', environment: 'production', sid: 'sid-gone' }], {
      endedSids: ['sid-gone'],
    });

    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({ status: 'skipped', reason: 'no_tokens' });
    expect(removedSids).toEqual(['sid-gone']);
    expect(deps.loadRecipient).not.toHaveBeenCalled();
    expect(deps.transport.send).not.toHaveBeenCalled();
  });

  it('does not prune when every session is live', async () => {
    const { deps } = makeDeps([{ token: 'tok-a', environment: 'production' }]);

    await expect(deliverPush(EVENT, deps, logger)).resolves.toMatchObject({ delivered: 1, pruned: 0 });
    expect(deps.tokens.removeBySids).not.toHaveBeenCalled();
  });

  it('sends the title, body, deepLink and collapse id to every device token', async () => {
    const { deps, sent } = makeDeps([
      { token: 'tok-a', environment: 'production' },
      { token: 'tok-b', environment: 'sandbox' },
    ]);

    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({
      status: 'sent',
      delivered: 2,
      pruned: 0,
      failed: 0,
    });
    expect(sent.map(r => [r.deviceToken, r.environment])).toEqual([
      ['tok-a', 'production'],
      ['tok-b', 'sandbox'],
    ]);
    expect(sent[0].headers).toEqual({
      'apns-topic': 'com.example.client',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': 'agent-run:exec-1',
    });
    expect(payloadOf(sent[0])).toEqual({
      aps: {
        alert: { title: 'Agent finished', body: 'Your agent finished its task in "Q3 plan".' },
        sound: 'default',
        'thread-id': 'session-1',
      },
      category: 'agent_completed',
      deepLink: 'https://app.example.test/notebooks/session-1',
      questId: 'quest-1',
      sessionId: 'session-1',
    });
  });

  it('keeps an absolute deepLink as published', async () => {
    const { deps, sent } = makeDeps([{ token: 'tok-a', environment: 'production' }]);
    await deliverPush({ ...EVENT, deepLink: 'https://elsewhere.test/notebooks/s' }, deps, logger);
    expect(payloadOf(sent[0]).deepLink).toBe('https://elsewhere.test/notebooks/s');
  });

  it('derives a collapse id from category and quest when the publisher sent none', async () => {
    const { deps, sent } = makeDeps([{ token: 'tok-a', environment: 'production' }]);
    await deliverPush({ ...EVENT, collapseId: undefined }, deps, logger);
    expect(sent[0].headers['apns-collapse-id']).toBe('agent_completed:quest-1');
  });

  it.each([[{ status: 410, reason: 'Unregistered' }], [{ status: 410 }], [{ status: 400, reason: 'Unregistered' }]])(
    'prunes a token APNs reports unregistered (%o) under its read-time sid and does not retry',
    async response => {
      const { deps, removed } = makeDeps(
        [
          { token: 'dead', environment: 'production', sid: 'sid-dead' },
          { token: 'live', environment: 'production' },
        ],
        { respond: request => (request.deviceToken === 'dead' ? response : { status: 200 }) }
      );

      await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({
        status: 'sent',
        delivered: 1,
        pruned: 1,
        failed: 1,
      });
      expect(removed).toEqual(['dead']);
      expect(deps.tokens.removeByToken).toHaveBeenCalledExactlyOnceWith('dead', { sid: 'sid-dead' });
    }
  );

  it('keeps a BadDeviceToken token: APNs also returns it for a sandbox/production mismatch', async () => {
    const { deps, removed } = makeDeps([{ token: 'mismatched', environment: 'production' }], {
      respond: () => ({ status: 400, reason: 'BadDeviceToken' }),
    });

    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({
      status: 'sent',
      delivered: 0,
      pruned: 0,
      failed: 1,
    });
    expect(removed).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('BadDeviceToken'),
      expect.objectContaining({ environment: 'production' })
    );
  });

  it('does not prune on DeviceTokenNotForTopic: it is a wrong APNS_TOPIC, reported once at error', async () => {
    const { deps, removed } = makeDeps(
      [
        { token: 'tok-a', environment: 'production' },
        { token: 'tok-b', environment: 'production' },
      ],
      { respond: () => ({ status: 400, reason: 'DeviceTokenNotForTopic' }) }
    );

    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({
      status: 'sent',
      delivered: 0,
      pruned: 0,
      failed: 2,
    });
    expect(removed).toEqual([]);
    expect(deps.tokens.removeByToken).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('server configuration'),
      expect.objectContaining({ reason: 'DeviceTokenNotForTopic', likelyCause: expect.stringContaining('APNS_TOPIC') })
    );
  });

  it.each([
    [{ status: 403, reason: 'InvalidProviderToken' }, 'APNS_KEY_ID'],
    [{ status: 403, reason: 'ExpiredProviderToken' }, 'clock'],
    [{ status: 403, reason: 'SomeFutureAuthReason' }, 'provider credentials'],
  ])('treats a 403 (%o) as a config error: error log, no retry, no prune', async (response, cause) => {
    const { deps } = makeDeps([{ token: 'tok-a', environment: 'production' }], { respond: () => response });

    await expect(deliverPush(EVENT, deps, logger)).resolves.toMatchObject({ delivered: 0, pruned: 0, failed: 1 });
    expect(deps.tokens.removeByToken).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ status: 403, likelyCause: expect.stringContaining(cause) })
    );
  });

  it('replaces title and body with category-generic copy when the organization redacts', async () => {
    const { deps, sent } = makeDeps([{ token: 'tok-a', environment: 'production' }], {
      loadRecipient: vi.fn(async () => ({ preferences: undefined, redactContent: true })),
    });

    await deliverPush(EVENT, deps, logger);

    const payload = payloadOf(sent[0]);
    expect(payload.aps.alert).toEqual(REDACTED_PUSH_COPY.agent_completed);
    expect(sent[0].payload).not.toContain('Q3 plan');
    expect(payload.deepLink).toBe('https://app.example.test/notebooks/session-1');
  });

  it('suppresses a category the user switched off and leaves the others on', async () => {
    const { deps } = makeDeps([{ token: 'tok-a', environment: 'production' }], {
      loadRecipient: vi.fn(async () => ({ preferences: { agent_completed: false }, redactContent: false })),
    });

    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({
      status: 'skipped',
      reason: 'category_disabled',
    });
    expect(deps.transport.send).not.toHaveBeenCalled();

    await expect(deliverPush({ ...EVENT, category: 'agent_failed' }, deps, logger)).resolves.toMatchObject({
      status: 'sent',
      delivered: 1,
    });
  });

  it('drops the event when the user no longer exists', async () => {
    const { deps } = makeDeps([{ token: 'tok-a', environment: 'production' }], {
      loadRecipient: vi.fn(async () => null),
    });
    await expect(deliverPush(EVENT, deps, logger)).resolves.toEqual({ status: 'skipped', reason: 'no_recipient' });
  });

  it('throws for an EventBridge retry only when every device failed transiently', async () => {
    const { deps } = makeDeps([{ token: 'tok-a', environment: 'production' }], {
      respond: () => ({ status: 503, reason: 'ServiceUnavailable' }),
    });
    await expect(deliverPush(EVENT, deps, logger)).rejects.toThrow(/failed transiently/);

    const partial = makeDeps(
      [
        { token: 'ok', environment: 'production' },
        { token: 'busy', environment: 'production' },
      ],
      { respond: request => (request.deviceToken === 'ok' ? { status: 200 } : { status: 503 }) }
    );
    await expect(deliverPush(EVENT, partial.deps, logger)).resolves.toMatchObject({ delivered: 1, failed: 1 });
  });

  it.each([
    ['an unregistered token', { status: 410, reason: 'Unregistered' }],
    ['a config error', { status: 400, reason: 'DeviceTokenNotForTopic' }],
    ['a permanent rejection', { status: 400, reason: 'BadDeviceToken' }],
  ])('still retries a transient failure that sits next to %s', async (_label, response) => {
    const { deps } = makeDeps(
      [
        { token: 'other', environment: 'production' },
        { token: 'busy', environment: 'production' },
      ],
      { respond: request => (request.deviceToken === 'busy' ? { status: 503 } : response) }
    );
    await expect(deliverPush(EVENT, deps, logger)).rejects.toThrow(/failed transiently for 1 of 2/);
  });

  it('caps the collapse id at 64 characters', async () => {
    const { deps, sent } = makeDeps([{ token: 'tok-a', environment: 'production' }]);
    await deliverPush({ ...EVENT, collapseId: 'c'.repeat(64) }, deps, logger);
    await deliverPush({ ...EVENT, collapseId: 'c'.repeat(65) }, deps, logger);
    expect(sent.map(request => request.headers['apns-collapse-id'])).toEqual(['c'.repeat(64), 'c'.repeat(64)]);
  });

  it.each([
    ['title', 80],
    ['body', 240],
  ] as const)('keeps a %s of exactly %i characters and ellipsizes one longer', async (field, max) => {
    const { deps, sent } = makeDeps([{ token: 'tok-a', environment: 'production' }]);
    await deliverPush({ ...EVENT, [field]: 'x'.repeat(max) }, deps, logger);
    await deliverPush({ ...EVENT, [field]: 'x'.repeat(max + 1) }, deps, logger);
    const [atCap, overCap] = sent.map(request => payloadOf(request).aps.alert[field] as string);
    expect(atCap).toBe('x'.repeat(max));
    expect(overCap).toHaveLength(max);
    expect(overCap.endsWith('...')).toBe(true);
  });

  it('does not retry a permanent rejection', async () => {
    const { deps } = makeDeps([{ token: 'tok-a', environment: 'production' }], {
      respond: () => ({ status: 400, reason: 'PayloadTooLarge' }),
    });
    await expect(deliverPush(EVENT, deps, logger)).resolves.toMatchObject({ delivered: 0, failed: 1 });
  });
});

describe('loadPushRecipient', () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the user's push preferences and the active organization's redaction flag", async () => {
    h.userFindById.mockResolvedValue({
      organizationId: 'org-1',
      preferences: { pushNotifications: { agent_message: false } },
    });
    h.orgFindById.mockResolvedValue({ redactPushContent: true });

    await expect(loadPushRecipient('u1')).resolves.toEqual({
      preferences: { agent_message: false },
      redactContent: true,
    });
    expect(h.orgFindById).toHaveBeenCalledWith('org-1');
  });

  it('does not redact for a user without an organization', async () => {
    h.userFindById.mockResolvedValue({ organizationId: null, preferences: null });
    await expect(loadPushRecipient('u1')).resolves.toEqual({ preferences: undefined, redactContent: false });
    expect(h.orgFindById).not.toHaveBeenCalled();
  });
});

describe('handler', () => {
  const VALID_KEY_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const APNS_ENV = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY', 'APNS_TOPIC'] as const;
  const saved: Partial<Record<(typeof APNS_ENV)[number], string>> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of APNS_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of APNS_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  const bridgeEvent = { 'detail-type': 'notification.push', detail: EVENT } as EventBridgeEvent<string, unknown>;

  it('consumes the event as a no-op, without a database connection, when APNs is not configured', async () => {
    process.env.APNS_KEY_ID = 'KEY123';
    // APNS_TEAM_ID, APNS_KEY and APNS_TOPIC unset: a partial config is no config.

    await expect(handler(bridgeEvent)).resolves.toBeUndefined();
    expect(h.withEventContextInner).not.toHaveBeenCalled();
    expect(h.findByUser).not.toHaveBeenCalled();
    expect(h.findLiveSids).not.toHaveBeenCalled();
  });

  it("treats the secrets' 'not-configured' placeholder as unset", async () => {
    Object.assign(process.env, {
      APNS_KEY_ID: 'not-configured',
      APNS_TEAM_ID: 'not-configured',
      APNS_KEY: 'not-configured',
      APNS_TOPIC: 'not-configured',
    });

    await expect(handler(bridgeEvent)).resolves.toBeUndefined();
    expect(h.withEventContextInner).not.toHaveBeenCalled();
  });

  it('consumes the event without retrying or reading the database when APNS_KEY is not a usable PEM', async () => {
    Object.assign(process.env, {
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'T',
      APNS_KEY: '-----BEGIN PRIVATE KEY-----\\nnot-a-key\\n-----END PRIVATE KEY-----',
      APNS_TOPIC: 'com.example.client',
    });

    await expect(handler(bridgeEvent)).resolves.toBeUndefined();
    expect(h.withEventContextInner).not.toHaveBeenCalled();
    expect(h.findByUser).not.toHaveBeenCalled();
    expect(h.findLiveSids).not.toHaveBeenCalled();
  });

  it('delivers through the configured path when every APNS_* value is set', async () => {
    Object.assign(process.env, {
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'T',
      APNS_KEY: VALID_KEY_PEM,
      APNS_TOPIC: 'com.example.client',
    });
    h.findByUser.mockResolvedValue([]);

    await handler(bridgeEvent);

    expect(h.withEventContextInner).toHaveBeenCalledTimes(1);
    expect(h.findByUser).toHaveBeenCalledWith(EVENT.userId, 'device');
  });
});
