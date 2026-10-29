// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

// vitest.setup.ts passes this middleware through for every other suite.
vi.unmock('@server/middlewares/defaultWriteRateLimit');

const mocks = vi.hoisted(() => ({
  tryIncrement: vi.fn(),
  getSettingsMap: vi.fn(),
  isDevelopment: vi.fn(() => false),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: mocks.tryIncrement },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mocks.getSettingsMap,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isDevelopment: mocks.isDevelopment }));

import { __resetDefaultWriteLimitCache, defaultWriteRateLimit } from './defaultWriteRateLimit';

const WINDOW_END = new Date(Date.now() + 30_000);

const run = async (overrides: Partial<Request> = {}) => {
  const warn = vi.fn();
  const req = {
    method: 'POST',
    url: '/api/feedback?x=1',
    user: { id: 'u1', isAdmin: false, tags: [] },
    logger: { warn },
    ...overrides,
  } as unknown as Request;
  const setHeader = vi.fn();
  const res = { setHeader } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  await defaultWriteRateLimit(req, res, next);
  return { next, setHeader, warn };
};

const settings = (mode: string, perMin = 120) =>
  mocks.getSettingsMap.mockResolvedValue({
    apiRateLimitDefaultWriteMode: mode,
    apiRateLimitDefaultWritePerMin: String(perMin),
  });

beforeEach(() => {
  vi.clearAllMocks();
  __resetDefaultWriteLimitCache();
  mocks.isDevelopment.mockReturnValue(false);
  mocks.tryIncrement.mockResolvedValue({ success: true, expiresAt: WINDOW_END });
  settings('enforce');
});

describe('defaultWriteRateLimit', () => {
  it('counts a signed-in write in one shared bucket per user, at the configured limit', async () => {
    settings('enforce', 75);
    const { next } = await run();
    expect(mocks.tryIncrement).toHaveBeenCalledWith('rate-limit:u1:default-write', 75, 60_000);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    ['a read', { method: 'GET' }],
    ['a HEAD', { method: 'HEAD' }],
    ['a preflight', { method: 'OPTIONS' }],
    ['an anonymous request', { user: undefined }],
    ['an API-key request', { apiKeyInfo: { keyId: 'k1' } }],
    ['an admin', { user: { id: 'a1', isAdmin: true, tags: [] } }],
    ['a developer-tagged user', { user: { id: 'd1', isAdmin: false, tags: ['developer'] } }],
  ])('does not count %s', async (_, overrides) => {
    const { next } = await run(overrides as Partial<Request>);
    expect(mocks.tryIncrement).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('does not count anything on a dev server', async () => {
    mocks.isDevelopment.mockReturnValue(true);
    await run();
    expect(mocks.tryIncrement).not.toHaveBeenCalled();
  });

  it('does not count anything when the mode is off', async () => {
    settings('off');
    const { next } = await run();
    expect(mocks.tryIncrement).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('refuses an over-limit write with 429 and Retry-After when enforcing', async () => {
    mocks.tryIncrement.mockResolvedValue({ success: false, expiresAt: WINDOW_END });
    const { next, setHeader, warn } = await run();
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 429 }));
    expect(warn).toHaveBeenCalledWith(
      '[defaultWriteRateLimit] over the default write limit',
      expect.objectContaining({ userId: 'u1', path: '/api/feedback', mode: 'enforce' })
    );
  });

  it('lets an over-limit write through in log mode, logging it once per window', async () => {
    settings('log');
    mocks.tryIncrement.mockResolvedValue({ success: false, expiresAt: WINDOW_END });
    const first = await run();
    const second = await run();
    expect(first.next).toHaveBeenCalledWith();
    expect(second.next).toHaveBeenCalledWith();
    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(second.warn).not.toHaveBeenCalled();
    expect(first.setHeader).not.toHaveBeenCalled();
  });

  it('falls back to logging at 120/min when the settings cannot be read', async () => {
    mocks.getSettingsMap.mockRejectedValue(new Error('db down'));
    mocks.tryIncrement.mockResolvedValue({ success: false, expiresAt: WINDOW_END });
    const { next } = await run();
    expect(mocks.tryIncrement).toHaveBeenCalledWith('rate-limit:u1:default-write', 120, 60_000);
    expect(next).toHaveBeenCalledWith();
  });

  it('falls back to log mode for an unknown stored mode', async () => {
    settings('bogus');
    mocks.tryIncrement.mockResolvedValue({ success: false, expiresAt: WINDOW_END });
    const { next } = await run();
    expect(next).toHaveBeenCalledWith();
  });

  it('reads the settings once per cache window, not per request', async () => {
    await run();
    await run();
    expect(mocks.getSettingsMap).toHaveBeenCalledTimes(1);
  });
});
