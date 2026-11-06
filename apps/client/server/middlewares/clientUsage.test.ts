// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  updateOne: vi.fn(),
  isApiKeyAuth: vi.fn(() => false),
}));

vi.mock('@bike4mind/database', () => ({ User: { updateOne: mocks.updateOne } }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ isApiKeyAuth: mocks.isApiKeyAuth }));

import { CLIENT_USAGE_STAMP_INTERVAL_MS, clientUsageMiddleware, needsClientUsageStamp } from './clientUsage';

const NOW = new Date('2026-11-06T12:00:00Z');

function makeReq(user: Record<string, unknown> | undefined, headers: Record<string, string> = {}): Request {
  return { user, headers, logger: { warn: vi.fn() } } as unknown as Request;
}

function run(req: Request): NextFunction {
  const next = vi.fn();
  clientUsageMiddleware()(req, {} as Response, next);
  return next;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.updateOne.mockReset().mockResolvedValue({ acknowledged: true });
  mocks.isApiKeyAuth.mockReset().mockReturnValue(false);
});

describe('clientUsageMiddleware', () => {
  it('records a first desktop sighting with its version', () => {
    const next = run(makeReq({ id: 'u1' }, { 'user-agent': 'b4m-desktop/1.4.2' }));

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      {
        $min: { 'clientUsage.desktop.firstSeenAt': NOW },
        $max: { 'clientUsage.desktop.lastSeenAt': NOW },
        $set: { 'clientUsage.desktop.version': '1.4.2' },
      },
      { timestamps: false }
    );
  });

  it('records a browser session as web, without a version', () => {
    run(makeReq({ id: 'u1' }, { 'user-agent': 'Mozilla/5.0' }));

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $min: { 'clientUsage.web.firstSeenAt': NOW }, $max: { 'clientUsage.web.lastSeenAt': NOW } },
      { timestamps: false }
    );
  });

  it('records an API key or OAuth token without a first-party header as api', () => {
    mocks.isApiKeyAuth.mockReturnValue(true);
    run(makeReq({ id: 'u1' }, { 'user-agent': 'curl/8' }));
    mocks.isApiKeyAuth.mockReturnValue(false);
    run(makeReq({ id: 'u2', oauthGrant: { scopes: [] } }, { 'user-agent': 'some-mcp-client/1' }));

    expect(mocks.updateOne.mock.calls.map(([filter, update]) => [filter, Object.keys(update.$max)[0]])).toEqual([
      [{ _id: 'u1' }, 'clientUsage.api.lastSeenAt'],
      [{ _id: 'u2' }, 'clientUsage.api.lastSeenAt'],
    ]);
  });

  it('skips the write when the surface was stamped within the day', () => {
    const lastSeenAt = new Date(NOW.getTime() - CLIENT_USAGE_STAMP_INTERVAL_MS + 1);
    run(makeReq({ id: 'u1', clientUsage: { web: { firstSeenAt: lastSeenAt, lastSeenAt } } }));

    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['no user', undefined],
    ['a system account', { id: 'u1', isSystem: true }],
    ['an account pending deletion', { id: 'u1', deletion: { requestedAt: NOW } }],
    ['an impersonated session', { id: 'u1', impersonatedBy: 'admin-1' }],
    ['an MFA-pending session', { id: 'u1', mfaPending: true }],
  ])('does not attribute %s', (_label, user) => {
    const next = run(makeReq(user, { 'user-agent': 'b4m-desktop/1.4.2' }));

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('logs a failed write instead of failing the request', async () => {
    const error = new Error('mongo down');
    mocks.updateOne.mockRejectedValue(error);
    const req = makeReq({ id: 'u1' });

    const next = run(req);
    await vi.runAllTimersAsync();

    expect(next).toHaveBeenCalledOnce();
    expect(req.logger.warn).toHaveBeenCalledWith('[clientUsage] failed to record client usage', {
      surface: 'web',
      error,
    });
  });
});

describe('needsClientUsageStamp', () => {
  const lastSeenAt = new Date(NOW.getTime() - 60_000);

  it('stamps a new client version even inside the day', () => {
    expect(
      needsClientUsageStamp(
        { firstSeenAt: lastSeenAt, lastSeenAt, version: '1.4.1' },
        { surface: 'desktop', version: '1.4.2' },
        NOW
      )
    ).toBe(true);
  });

  it('stamps once the last sighting is a day old', () => {
    const dayOld = new Date(NOW.getTime() - CLIENT_USAGE_STAMP_INTERVAL_MS);
    expect(needsClientUsageStamp({ firstSeenAt: dayOld, lastSeenAt: dayOld }, { surface: 'web' }, NOW)).toBe(true);
  });
});
