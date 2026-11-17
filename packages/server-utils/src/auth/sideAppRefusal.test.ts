import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  record: vi.fn(),
  increment: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@bike4mind/database/auth', () => ({
  sideAppRefusalRepository: { record: h.record },
  sideAppRefusalCounterRepository: { increment: h.increment },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { warn: h.warn } } }));

import {
  classifySideAppRefusal,
  recordSideAppRefusal,
  resetSideAppRefusalCap,
  SIDE_APP_REFUSAL_CLASS,
  sideAppRefusalCapLimits,
  sideAppRefusalCapSize,
} from './sideAppRefusal';

const verified = (clientId: string, reason = 'invalid_scope') =>
  recordSideAppRefusal({ verified: true, clientId, stage: 'mint', reason, status: 403 });

describe('recordSideAppRefusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T10:00:10.000Z'));
    resetSideAppRefusalCap();
    h.record.mockResolvedValue(undefined);
    h.increment.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('writes a verified refusal as a row', () => {
    recordSideAppRefusal({
      verified: true,
      clientId: 'app-1',
      stage: 'use',
      reason: 'subscription_required',
      status: 403,
      userId: 'u1',
      keyId: 'k1',
      endpoint: '/api/chat',
    });
    expect(h.record).toHaveBeenCalledWith({
      clientId: 'app-1',
      stage: 'use',
      reason: 'subscription_required',
      status: 403,
      userId: 'u1',
      keyId: 'k1',
      endpoint: '/api/chat',
    });
    expect(h.increment).not.toHaveBeenCalled();
  });

  it('turns a flood of random claimed ids into counter increments only, never rows or ids', () => {
    for (let i = 0; i < 500; i++) {
      recordSideAppRefusal({
        verified: false,
        clientId: `random-${i}`,
        stage: 'mint',
        reason: 'invalid_client',
        status: 401,
      });
    }
    expect(h.record).not.toHaveBeenCalled();
    expect(h.increment).toHaveBeenCalledTimes(500);
    expect(h.increment.mock.calls.every(call => call.length === 1 && call[0] === 'invalid_client')).toBe(true);
    expect(sideAppRefusalCapSize()).toBe(0);
  });

  it('treats a verified refusal with no client id as unverified', () => {
    recordSideAppRefusal({ verified: true, stage: 'mint', reason: 'invalid_request', status: 400 });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.increment).toHaveBeenCalledWith('invalid_request');
  });

  it('caps verified rows per client and reason per minute, then admits again in the next minute', () => {
    const { perMinute } = sideAppRefusalCapLimits;
    for (let i = 0; i < perMinute + 30; i++) verified('app-1');
    expect(h.record).toHaveBeenCalledTimes(perMinute);

    verified('app-1', 'invalid_grant');
    verified('app-2');
    expect(h.record).toHaveBeenCalledTimes(perMinute + 2);

    vi.setSystemTime(new Date('2026-11-15T10:01:05.000Z'));
    verified('app-1');
    expect(h.record).toHaveBeenCalledTimes(perMinute + 3);
  });

  it('never grows the cap map past its maximum and evicts the oldest pair', () => {
    const { maxEntries } = sideAppRefusalCapLimits;
    for (let i = 0; i < maxEntries * 3; i++) {
      verified(`app-${i}`);
      expect(sideAppRefusalCapSize()).toBeLessThanOrEqual(maxEntries);
    }
    expect(sideAppRefusalCapSize()).toBe(maxEntries);

    h.record.mockClear();
    verified('app-0');
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected database write and logs a warning', async () => {
    h.record.mockRejectedValue(new Error('mongo down'));
    h.increment.mockRejectedValue(new Error('mongo down'));
    expect(() => verified('app-1')).not.toThrow();
    expect(() =>
      recordSideAppRefusal({ verified: false, stage: 'mint', reason: 'invalid_client', status: 401 })
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls[0][0]).toContain('mongo down');
  });

  it('swallows a synchronous throw from the repository', () => {
    h.record.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => verified('app-1')).not.toThrow();
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the write', () => {
    h.record.mockReturnValue(new Promise(() => undefined));
    expect(
      recordSideAppRefusal({ verified: true, clientId: 'a', stage: 'mint', reason: 'x', status: 403 })
    ).toBeUndefined();
  });
});

describe('classifySideAppRefusal', () => {
  it.each([
    ['subscription_required', 'policy'],
    ['invalid_scope', 'policy'],
    ['access_denied', 'policy'],
    ['insufficient_scope', 'policy'],
    ['route_not_allowed', 'policy'],
    ['rate_limited', 'app_fault'],
    ['idp_unavailable', 'app_fault'],
    ['invalid_grant', 'app_fault'],
    ['invalid_request', 'app_fault'],
    ['invalid_client', 'app_fault'],
    ['temporarily_unavailable', 'our_fault'],
    ['server_error', 'our_fault'],
  ])('%s is %s', (reason, expected) => {
    expect(classifySideAppRefusal(reason)).toBe(expected);
    expect(SIDE_APP_REFUSAL_CLASS[reason]).toBe(expected);
  });

  it('surfaces an unknown reason as our fault', () => {
    expect(classifySideAppRefusal('something_new')).toBe('our_fault');
  });
});
