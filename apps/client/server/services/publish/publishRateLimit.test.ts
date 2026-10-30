import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PUBLISH_RATE_LIMITED, PUBLISH_RATE_LIMITS, TooManyRequestsError } from '@bike4mind/common';

const cache = vi.hoisted(() => ({ tryAcquireLease: vi.fn(), findByKey: vi.fn(), releaseLease: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ cacheRepository: cache }));

import errorHandler from '@server/middlewares/errorHandler';
import { consumePublishAction, publishActionLimit, publishActionsKey } from './publishRateLimit';

/** A 24-hex ObjectId string minted at `ms`, as Mongo stamps a new user's _id. */
const objectIdAt = (ms: number) =>
  `${Math.floor(ms / 1000)
    .toString(16)
    .padStart(8, '0')}0000000000000000`;

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const established = { id: 'u1', isAdmin: false, createdAt: new Date(NOW - 30 * DAY_MS) };
const brandNew = { id: 'u2', isAdmin: false, createdAt: new Date(NOW - DAY_MS) };

/** A full allowance whose oldest action lapses `firstFreeInMs` from now. */
const fullLog = (limit: number, firstFreeInMs: number) => ({
  key: 'k',
  result: {
    holders: Array.from({ length: limit }, (_, i) => ({
      id: `h${i}`,
      expiresAt: new Date(NOW + firstFreeInMs + i * 60_000),
    })),
  },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  cache.tryAcquireLease.mockReset().mockResolvedValue(true);
  cache.findByKey.mockReset().mockResolvedValue(null);
  cache.releaseLease.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('publishActionLimit', () => {
  it('gives an established account the standard allowance', () => {
    expect(publishActionLimit(established, NOW)).toBe(PUBLISH_RATE_LIMITS.maxActions);
    expect(PUBLISH_RATE_LIMITS.maxActions).toBe(200);
  });

  it('gives an account younger than 7 days the new-account allowance', () => {
    expect(publishActionLimit(brandNew, NOW)).toBe(PUBLISH_RATE_LIMITS.newAccount.maxActions);
    expect(PUBLISH_RATE_LIMITS.newAccount.maxActions).toBe(20);
  });

  it('switches tiers exactly at the 7-day mark', () => {
    const sevenDays = PUBLISH_RATE_LIMITS.newAccount.maxAgeMs;
    expect(publishActionLimit({ id: 'u', createdAt: new Date(NOW - sevenDays + 1) }, NOW)).toBe(20);
    expect(publishActionLimit({ id: 'u', createdAt: new Date(NOW - sevenDays) }, NOW)).toBe(200);
  });

  it('reads a serialized creation time', () => {
    expect(publishActionLimit({ id: 'u', createdAt: new Date(NOW - 30 * DAY_MS).toISOString() }, NOW)).toBe(200);
  });

  it('treats a missing or unreadable creation time as a new account', () => {
    expect(publishActionLimit({ id: 'u' }, NOW)).toBe(20);
    expect(publishActionLimit({ id: 'u', createdAt: null }, NOW)).toBe(20);
    expect(publishActionLimit({ id: 'u', createdAt: 'not a date' }, NOW)).toBe(20);
  });

  it("falls back to the creation time in the user's ObjectId when createdAt is missing", () => {
    expect(publishActionLimit({ id: objectIdAt(NOW - 30 * DAY_MS) }, NOW)).toBe(200);
    expect(publishActionLimit({ id: objectIdAt(NOW - 30 * DAY_MS), createdAt: null }, NOW)).toBe(200);
    expect(publishActionLimit({ id: objectIdAt(NOW - DAY_MS) }, NOW)).toBe(20);
  });

  it('prefers createdAt over the ObjectId time when both are readable', () => {
    expect(publishActionLimit({ id: objectIdAt(NOW - 30 * DAY_MS), createdAt: new Date(NOW - DAY_MS) }, NOW)).toBe(20);
  });

  it('exempts admins', () => {
    expect(publishActionLimit({ ...brandNew, isAdmin: true }, NOW)).toBe(Infinity);
  });
});

describe('PublishActionReceipt.refund', () => {
  it('removes exactly the entry the action added, from the same log', async () => {
    const receipt = await consumePublishAction(established);
    const [key, actionId] = cache.tryAcquireLease.mock.calls[0];

    await receipt.refund();

    expect(cache.releaseLease).toHaveBeenCalledTimes(1);
    expect(cache.releaseLease).toHaveBeenCalledWith(key, actionId);
  });

  it("refunds each action by its own id, never another action's", async () => {
    const first = await consumePublishAction(brandNew);
    await consumePublishAction(brandNew);
    const [firstId, secondId] = cache.tryAcquireLease.mock.calls.map(call => call[1]);

    await first.refund();

    expect(cache.releaseLease.mock.calls.map(call => call[1])).toEqual([firstId]);
    expect(firstId).not.toBe(secondId);
  });

  it('never throws: a failed refund only leaves the action counted', async () => {
    const receipt = await consumePublishAction(established);
    cache.releaseLease.mockRejectedValue(new Error('cache down'));

    await expect(receipt.refund()).resolves.toBeUndefined();
  });

  it("is a no-op for an admin's uncounted action", async () => {
    const receipt = await consumePublishAction({ ...established, isAdmin: true });
    await receipt.refund();
    expect(cache.releaseLease).not.toHaveBeenCalled();
  });
});

describe('consumePublishAction', () => {
  it("records one action on the user's rolling-window log at the tier's limit", async () => {
    await consumePublishAction(established);

    expect(cache.tryAcquireLease).toHaveBeenCalledTimes(1);
    const [key, holderId, limit, windowMs] = cache.tryAcquireLease.mock.calls[0];
    expect(key).toBe(publishActionsKey('u1'));
    expect(key).toBe('rate-limit:u1:publish-actions');
    expect(typeof holderId).toBe('string');
    expect(limit).toBe(200);
    expect(windowMs).toBe(PUBLISH_RATE_LIMITS.windowMs);
  });

  it('records each action under a distinct id, so repeats are counted rather than merged', async () => {
    await consumePublishAction(brandNew);
    await consumePublishAction(brandNew);

    const ids = cache.tryAcquireLease.mock.calls.map(call => call[1]);
    expect(new Set(ids).size).toBe(2);
    expect(cache.tryAcquireLease.mock.calls.every(call => call[2] === 20)).toBe(true);
  });

  it('never touches the counter for an admin', async () => {
    await consumePublishAction({ ...established, isAdmin: true });
    expect(cache.tryAcquireLease).not.toHaveBeenCalled();
  });

  it('refuses with a 429 whose Retry-After is when the oldest action lapses', async () => {
    cache.tryAcquireLease.mockResolvedValue(false);
    cache.findByKey.mockResolvedValue(fullLog(20, 42 * 60_000 - 30_000));

    const error = await consumePublishAction(brandNew).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TooManyRequestsError);
    const refusal = error as TooManyRequestsError;
    expect(refusal.statusCode).toBe(429);
    expect(refusal.message).toBe("You've published a lot today. Try again in 42 minutes.");
    expect(refusal.additionalInfo).toEqual({
      code: PUBLISH_RATE_LIMITED,
      retryAfter: 42 * 60 - 30,
      details: { limit: 20, windowMs: PUBLISH_RATE_LIMITS.windowMs },
    });
    expect(cache.findByKey).toHaveBeenCalledWith('rate-limit:u2:publish-actions');
  });

  it('counts past lapsed and surplus entries when working out the wait', async () => {
    cache.tryAcquireLease.mockResolvedValue(false);
    // 2 lapsed entries are ignored; with 22 live against a limit of 20, room opens when the 3rd lapses.
    const live = Array.from({ length: 22 }, (_, i) => ({ id: `l${i}`, expiresAt: new Date(NOW + (i + 1) * 60_000) }));
    const lapsed = [0, 1].map(i => ({ id: `x${i}`, expiresAt: new Date(NOW - 1000) }));
    cache.findByKey.mockResolvedValue({ key: 'k', result: { holders: [...lapsed, ...live.reverse()] } });

    const error = (await consumePublishAction(brandNew).catch((e: unknown) => e)) as TooManyRequestsError;

    expect(error.additionalInfo?.retryAfter).toBe(3 * 60);
  });

  it('falls back to a short wait when the log reads as having room again', async () => {
    cache.tryAcquireLease.mockResolvedValue(false);
    cache.findByKey.mockResolvedValue(null);

    const error = (await consumePublishAction(brandNew).catch((e: unknown) => e)) as TooManyRequestsError;

    expect(error.additionalInfo?.retryAfter).toBe(1);
    expect(error.message).toBe("You've published a lot today. Try again in 1 minute.");
  });

  it('answers through errorHandler with the standard envelope, the code and a Retry-After header', async () => {
    cache.tryAcquireLease.mockResolvedValue(false);
    cache.findByKey.mockResolvedValue(fullLog(200, 90 * 60_000));
    const error = await consumePublishAction(established).catch((e: unknown) => e);

    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const setHeader = vi.fn();
    // Minimal stand-ins for the Node req/res: only the fields errorHandler() touches.
    const res = { status, json, setHeader } as unknown as Parameters<typeof errorHandler>[2];
    const req = {
      method: 'POST',
      url: '/api/publish/reply',
      requestId: 'req-1',
      logger: { warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<typeof errorHandler>[1];
    errorHandler(error, req, res);

    expect(status).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', String(90 * 60));
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "You've published a lot today. Try again in about 2 hours.",
        code: 'publish_rate_limited',
        retryAfter: 90 * 60,
        details: { limit: 200, windowMs: PUBLISH_RATE_LIMITS.windowMs },
        request_id: 'req-1',
      })
    );
  });
});
