// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveUserType } from './resolveUserType';

afterEach(() => vi.restoreAllMocks());

describe('resolveUserType', () => {
  it('DemoUser is always free', () => {
    expect(resolveUserType({ level: 'DemoUser', subscribedUntil: null })).toBe('free');
    expect(resolveUserType({ level: 'DemoUser', subscribedUntil: '2099-01-01' })).toBe('free');
  });

  it('PaidUser with no subscribedUntil → free', () => {
    expect(resolveUserType({ level: 'PaidUser', subscribedUntil: null })).toBe('free');
  });

  it('PaidUser with future subscribedUntil → subscriber', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(resolveUserType({ level: 'PaidUser', subscribedUntil: future })).toBe('subscriber');
  });

  it('PaidUser with past subscribedUntil → free (expired subscription)', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(resolveUserType({ level: 'PaidUser', subscribedUntil: past })).toBe('free');
  });

  it('PaidUser with unparseable subscribedUntil → free', () => {
    expect(resolveUserType({ level: 'PaidUser', subscribedUntil: 'not-a-date' })).toBe('free');
  });

  it('VIPUser → subscriber regardless of subscribedUntil', () => {
    expect(resolveUserType({ level: 'VIPUser', subscribedUntil: null })).toBe('subscriber');
    expect(resolveUserType({ level: 'VIPUser', subscribedUntil: '2000-01-01' })).toBe('subscriber');
  });

  it('ManagerUser → subscriber', () => {
    expect(resolveUserType({ level: 'ManagerUser', subscribedUntil: null })).toBe('subscriber');
  });

  it('AdminUser → subscriber', () => {
    expect(resolveUserType({ level: 'AdminUser', subscribedUntil: null })).toBe('subscriber');
  });
});
