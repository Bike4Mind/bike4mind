// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({ updateOne: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ User: { updateOne: mocks.updateOne } }));

import { userActivityMiddleware } from './userActivity';
import {
  USER_ACTIVITY_STAMP_INTERVAL_MS,
  needsActivityStamp,
  recordUserActivity,
  resetRecentActivityStamps,
} from '@server/users/recordUserActivity';

const NOW = new Date('2026-11-11T12:00:00Z');
const STALE_BEFORE = new Date(NOW.getTime() - USER_ACTIVITY_STAMP_INTERVAL_MS);
const STAMP_FILTER = {
  _id: 'user-1',
  isSystem: { $ne: true },
  deletion: null,
  $or: [{ lastActiveAt: null }, { lastActiveAt: { $lte: STALE_BEFORE } }],
};

function makeReq(method: string, user: Record<string, unknown> | undefined): Request {
  return { method, user, logger: { warn: vi.fn() } } as unknown as Request;
}

function run(req: Request): NextFunction {
  const next = vi.fn();
  userActivityMiddleware()(req, {} as Response, next);
  return next;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.updateOne.mockReset().mockResolvedValue({ acknowledged: true });
  resetRecentActivityStamps();
});

describe('userActivityMiddleware', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('stamps lastActiveAt on a %s', method => {
    const next = run(makeReq(method, { id: 'user-1' }));

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.updateOne).toHaveBeenCalledWith(STAMP_FILTER, { $set: { lastActiveAt: NOW } }, { timestamps: false });
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never stamps on a %s: reading is not acting', method => {
    const next = run(makeReq(method, { id: 'user-1' }));

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('skips the write while the stored stamp is inside the throttle window', () => {
    const recent = new Date(NOW.getTime() - USER_ACTIVITY_STAMP_INTERVAL_MS + 1000);

    run(makeReq('POST', { id: 'user-1', lastActiveAt: recent }));

    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('writes again once the stored stamp is older than the window', () => {
    run(makeReq('POST', { id: 'user-1', lastActiveAt: STALE_BEFORE }));

    expect(mocks.updateOne).toHaveBeenCalledOnce();
  });

  it.each([
    ['an impersonated session', { impersonatedBy: 'admin-1' }],
    ['an MFA-pending session', { mfaPending: true }],
    ['the system user', { isSystem: true }],
    ['an account pending deletion', { deletion: { requestedAt: NOW } }],
  ])('does not stamp for %s', (_label, extra) => {
    run(makeReq('POST', { id: 'user-1', ...extra }));

    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('passes through an anonymous request', () => {
    const next = run(makeReq('POST', undefined));

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('logs a failed write and never fails the request', async () => {
    mocks.updateOne.mockRejectedValue(new Error('mongo down'));
    const req = makeReq('POST', { id: 'user-1' });

    const next = run(req);
    await vi.waitFor(() => expect(req.logger.warn).toHaveBeenCalled());

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('recordUserActivity', () => {
  it('filters on the window, the system user and pending deletion, so the database holds the guard', () => {
    recordUserActivity('user-1');

    expect(mocks.updateOne).toHaveBeenCalledWith(STAMP_FILTER, { $set: { lastActiveAt: NOW } }, { timestamps: false });
  });

  it('skips the round trip for a user this container stamped inside the window', () => {
    recordUserActivity('user-1');
    vi.setSystemTime(NOW.getTime() + 60_000);
    recordUserActivity('user-1');
    recordUserActivity('user-2');

    expect(mocks.updateOne).toHaveBeenCalledTimes(2);
    expect(mocks.updateOne.mock.calls.map(([filter]) => filter._id)).toEqual(['user-1', 'user-2']);
  });

  it('writes again once the window has passed', () => {
    recordUserActivity('user-1');
    vi.setSystemTime(NOW.getTime() + USER_ACTIVITY_STAMP_INTERVAL_MS);
    recordUserActivity('user-1');

    expect(mocks.updateOne).toHaveBeenCalledTimes(2);
  });

  it('retries on the next action after a failed write', async () => {
    mocks.updateOne.mockRejectedValueOnce(new Error('mongo down'));
    const logger = { warn: vi.fn() };

    recordUserActivity('user-1', logger);
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    recordUserActivity('user-1', logger);

    expect(mocks.updateOne).toHaveBeenCalledTimes(2);
  });
});

describe('needsActivityStamp', () => {
  it('stamps a user who has never acted', () => {
    expect(needsActivityStamp(undefined, NOW)).toBe(true);
    expect(needsActivityStamp(null, NOW)).toBe(true);
  });

  it('holds the throttle for the whole window', () => {
    expect(needsActivityStamp(new Date(NOW.getTime() - 60_000), NOW)).toBe(false);
    expect(needsActivityStamp(STALE_BEFORE.toISOString(), NOW)).toBe(true);
  });
});
