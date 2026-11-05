import { describe, it, expect, beforeEach } from 'vitest';
import { RegInviteStatusType } from '@bike4mind/common';
import { RegistrationInvite, registrationInviteRepository } from './RegistrationInviteModel';
import { setupMongoTest } from '../../__test__/utils';

const NOW = new Date('2026-06-15T12:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

let seq = 0;
const invite = (over: Record<string, unknown>) =>
  RegistrationInvite.create({ status: RegInviteStatusType.open, userId: 'admin-1', code: `CODE${seq++}`, ...over });

describe('RegistrationInviteRepository.usageByGrantPackage', () => {
  setupMongoTest();

  beforeEach(async () => {
    await RegistrationInvite.deleteMany({});
  });

  it('counts active codes and the soonest expiry among them', async () => {
    await Promise.all([
      invite({ grantPackageId: 'a', expiresAt: day(10) }),
      invite({ grantPackageId: 'a', expiresAt: day(3) }),
      invite({ grantPackageId: 'a' }),
      // Expired: counted as a code, not active, and never the next expiry.
      invite({ grantPackageId: 'a', expiresAt: day(-1) }),
      // Used single-use code with the earliest future expiry: not active, so it must not win.
      invite({
        grantPackageId: 'a',
        status: RegInviteStatusType.used,
        used: day(-1),
        usedbyId: 'user-1',
        expiresAt: day(1),
      }),
      // Used but unlimited-use stays redeemable.
      invite({ grantPackageId: 'a', used: day(-1), unlimitedUse: true, expiresAt: day(2) }),
      invite({ grantPackageId: 'other', expiresAt: day(1) }),
      invite({}),
    ]);

    const usage = await registrationInviteRepository.usageByGrantPackage(['a', 'missing'], NOW);

    expect(usage.get('a')).toEqual({ codes: 6, activeCodes: 4, nextExpiry: day(2) });
    expect(usage.has('missing')).toBe(false);
    expect(usage.has('other')).toBe(false);
  });

  it('counts a waiting code as active, since redemption does not check status', async () => {
    await invite({ grantPackageId: 'a', status: RegInviteStatusType.waiting, expiresAt: day(1) });

    const usage = await registrationInviteRepository.usageByGrantPackage(['a'], NOW);

    expect(usage.get('a')).toEqual({ codes: 1, activeCodes: 1, nextExpiry: day(1) });
  });

  it('counts a code expiring at exactly now as active, matching the redemption check', async () => {
    await invite({ grantPackageId: 'a', expiresAt: NOW });

    const usage = await registrationInviteRepository.usageByGrantPackage(['a'], NOW);

    expect(usage.get('a')).toEqual({ codes: 1, activeCodes: 1, nextExpiry: NOW });
  });

  it('reports no expiry when no active code carries one', async () => {
    await Promise.all([invite({ grantPackageId: 'a' }), invite({ grantPackageId: 'a', expiresAt: day(-2) })]);

    const usage = await registrationInviteRepository.usageByGrantPackage(['a'], NOW);

    expect(usage.get('a')).toEqual({ codes: 2, activeCodes: 1, nextExpiry: null });
  });

  it('returns an empty map for no ids', async () => {
    await invite({ grantPackageId: 'a' });
    expect((await registrationInviteRepository.usageByGrantPackage([], NOW)).size).toBe(0);
  });
});
