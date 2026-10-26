import { describe, it, expect } from 'vitest';
import { BlockedIP, blockedIPRepository, DEFAULT_BLOCK_DURATION_MS } from './BlockedIPModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('BlockedIPRepository', () => {
  it('keeps the 10-minute manual default for block(ip, reason)', async () => {
    const doc = await blockedIPRepository.block('1.1.1.1', 'admin');
    expect(doc.source).toBe('manual');
    expect(doc.escalationLevel).toBe(0);
    expect(doc.expiresAt.getTime() - doc.blockedAt.getTime()).toBe(DEFAULT_BLOCK_DURATION_MS);
  });

  it('stores the given duration, source and escalation level', async () => {
    const doc = await blockedIPRepository.block('1.1.1.2', 'auto', {
      durationMs: 3_600_000,
      source: 'auto',
      escalationLevel: 1,
    });
    expect(doc.source).toBe('auto');
    expect(doc.escalationLevel).toBe(1);
    expect(doc.expiresAt.getTime() - doc.blockedAt.getTime()).toBe(3_600_000);
  });

  it('returns the existing active block instead of creating a second', async () => {
    const first = await blockedIPRepository.block('1.1.1.3', 'a');
    const second = await blockedIPRepository.block('1.1.1.3', 'b', { durationMs: 86_400_000, source: 'auto' });
    expect(String(second._id)).toBe(String(first._id));
    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
    expect(await BlockedIP.countDocuments({ ip: '1.1.1.3' })).toBe(1);
  });

  it('counts only auto blocks of that IP inside the window', async () => {
    const ip = '2.2.2.2';
    const now = Date.now();
    const row = (o: Record<string, unknown>) => ({
      ip,
      active: false,
      expiresAt: new Date(now),
      source: 'auto',
      blockedAt: new Date(now - 60_000),
      ...o,
    });
    await BlockedIP.create([
      row({}),
      row({ blockedAt: new Date(now - 30_000) }),
      row({ source: 'manual' }),
      row({ blockedAt: new Date(now - 48 * 3_600_000) }),
      row({ ip: '2.2.2.3' }),
    ]);
    expect(await blockedIPRepository.countAutoBlocksSince(ip, new Date(now - 24 * 3_600_000))).toBe(2);
  });
});
