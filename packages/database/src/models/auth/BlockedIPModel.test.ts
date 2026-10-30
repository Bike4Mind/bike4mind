import { describe, it, expect } from 'vitest';
import { BlockedIP, blockedIPRepository, DEFAULT_BLOCK_DURATION_MS } from './BlockedIPModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

describe('BlockedIPRepository', () => {
  it('keeps the 10-minute manual default for block(ip, reason)', async () => {
    const { doc, created } = await blockedIPRepository.block('1.1.1.1', 'admin');
    expect(created).toBe(true);
    expect(doc.source).toBe('manual');
    expect(doc.escalationLevel).toBe(0);
    expect(doc.expiresAt.getTime() - doc.blockedAt.getTime()).toBe(DEFAULT_BLOCK_DURATION_MS);
  });

  it('stores the given duration, source and escalation level', async () => {
    const { doc, created } = await blockedIPRepository.block('1.1.1.2', 'auto', {
      durationMs: 3_600_000,
      source: 'auto',
      escalationLevel: 1,
    });
    expect(created).toBe(true);
    expect(doc.source).toBe('auto');
    expect(doc.escalationLevel).toBe(1);
    expect(doc.expiresAt.getTime() - doc.blockedAt.getTime()).toBe(3_600_000);
  });

  it('extends the existing active block instead of creating a second', async () => {
    const { doc: first } = await blockedIPRepository.block('1.1.1.3', 'a');
    const { doc: second, created } = await blockedIPRepository.block('1.1.1.3', 'b', {
      durationMs: 86_400_000,
      source: 'auto',
    });
    expect(created).toBe(false);
    expect(String(second._id)).toBe(String(first._id));
    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(first.blockedAt.getTime() + 86_400_000);
    expect(await BlockedIP.countDocuments({ ip: '1.1.1.3' })).toBe(1);
  });

  it('never shortens an active block when a shorter one is requested', async () => {
    const { doc: auto } = await blockedIPRepository.block('1.1.1.4', 'auto', {
      durationMs: 86_400_000,
      source: 'auto',
      escalationLevel: 2,
    });
    const { doc: manual, created } = await blockedIPRepository.block('1.1.1.4', 'admin');
    expect(created).toBe(false);
    expect(manual.expiresAt.getTime()).toBe(auto.expiresAt.getTime());
  });

  it('extends the current block, not a stale expired row still marked active', async () => {
    const now = Date.now();
    await BlockedIP.create([
      {
        ip: '1.1.1.5',
        active: true,
        expiresAt: new Date(now - 1000),
        blockedAt: new Date(now - 60_000),
        reason: 'stale',
      },
      {
        ip: '1.1.1.5',
        active: true,
        expiresAt: new Date(now + 60_000),
        blockedAt: new Date(now - 1000),
        reason: 'current',
      },
    ]);
    const { doc, created } = await blockedIPRepository.block('1.1.1.5', 'auto', { durationMs: 3_600_000 });
    expect(created).toBe(false);
    expect(doc.reason).toBe('current');
    expect(doc.expiresAt.getTime()).toBeGreaterThanOrEqual(now + 3_600_000);
    expect((await blockedIPRepository.findLatestBlock('1.1.1.5'))?.expiresAt.getTime()).toBe(doc.expiresAt.getTime());
  });

  it('unblock deactivates every active row of the IP', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await BlockedIP.create([
      { ip: '4.4.4.4', active: true, expiresAt, blockedAt: new Date(Date.now() - 2000) },
      { ip: '4.4.4.4', active: true, expiresAt, blockedAt: new Date(Date.now() - 1000), reason: 'newest' },
    ]);
    expect((await blockedIPRepository.unblock('4.4.4.4'))?.reason).toBe('newest');
    expect(await blockedIPRepository.isBlocked('4.4.4.4')).toBeNull();
    expect(await BlockedIP.countDocuments({ ip: '4.4.4.4', active: true })).toBe(0);
  });

  it('returns the latest block of an IP regardless of state', async () => {
    const now = Date.now();
    await BlockedIP.create([
      { ip: '3.3.3.3', active: false, expiresAt: new Date(now), blockedAt: new Date(now - 5000) },
      { ip: '3.3.3.3', active: false, expiresAt: new Date(now), blockedAt: new Date(now - 1000), reason: 'new' },
    ]);
    expect((await blockedIPRepository.findLatestBlock('3.3.3.3'))?.reason).toBe('new');
    expect(await blockedIPRepository.findLatestBlock('9.9.9.9')).toBeNull();
  });
});
