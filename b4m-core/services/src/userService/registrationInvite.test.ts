import { describe, it, expect, vi } from 'vitest';
import { RegInviteSource, RegInviteStatusType, type IRegInviteDocument } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import {
  claimRegistrationInvite,
  redeemRegistrationInvite,
  referralInviteCredits,
  resolveRegistrationInvite,
} from './registrationInvite';

const EMAIL = 'invitee@example.com';

function invite(extra: Partial<IRegInviteDocument> = {}): IRegInviteDocument {
  return {
    id: 'invite-1',
    code: 'CODE1',
    userId: 'inviter-1',
    status: RegInviteStatusType.open,
    unlimitedUse: false,
    ...extra,
  } as IRegInviteDocument;
}

const repo = (found: IRegInviteDocument | null) => ({ findByCode: vi.fn().mockResolvedValue(found) });

describe('resolveRegistrationInvite', () => {
  it.each([undefined, null, '', '   '])('returns null without a lookup for %j', async code => {
    const invites = repo(invite());
    await expect(resolveRegistrationInvite(code, EMAIL, invites)).resolves.toBeNull();
    expect(invites.findByCode).not.toHaveBeenCalled();
  });

  it('looks the code up trimmed', async () => {
    const invites = repo(invite());
    await resolveRegistrationInvite('  CODE1 ', EMAIL, invites);
    expect(invites.findByCode).toHaveBeenCalledWith('CODE1');
  });

  it('rejects an unknown, expired, used or other-inbox code', async () => {
    await expect(resolveRegistrationInvite('X', EMAIL, repo(null))).rejects.toThrow('Invalid invite code');
    await expect(
      resolveRegistrationInvite('X', EMAIL, repo(invite({ expiresAt: new Date(Date.now() - 1000) })))
    ).rejects.toThrow('Invite code has expired');
    await expect(resolveRegistrationInvite('X', EMAIL, repo(invite({ used: new Date() })))).rejects.toThrow(
      'Invite code already used'
    );
    await expect(
      resolveRegistrationInvite('X', EMAIL, repo(invite({ email: 'Someone@Example.com' })))
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('accepts a used unlimited code and an email bound to the same inbox in another case', async () => {
    const resolved = await resolveRegistrationInvite(
      'X',
      EMAIL,
      repo(invite({ used: new Date(), unlimitedUse: true, email: ' Invitee@Example.com ' }))
    );
    expect(resolved).toMatchObject({ isUnlimited: true, isReferral: false });
  });

  it('flags only a single-use refer-flow code as a referral', async () => {
    const referral = await resolveRegistrationInvite('X', EMAIL, repo(invite({ source: RegInviteSource.referral })));
    expect(referral?.isReferral).toBe(true);
    const unlimited = await resolveRegistrationInvite(
      'X',
      EMAIL,
      repo(invite({ source: RegInviteSource.referral, unlimitedUse: true }))
    );
    expect(unlimited?.isReferral).toBe(false);
    const legacy = await resolveRegistrationInvite('X', EMAIL, repo(invite()));
    expect(legacy?.isReferral).toBe(false);
  });
});

describe('claimRegistrationInvite', () => {
  it('claims a single-use code and releases it at the same timestamp', async () => {
    const claimUnused = vi.fn().mockResolvedValue(true);
    const releaseClaim = vi.fn();
    const claim = await claimRegistrationInvite(
      { invite: invite(), isUnlimited: false },
      { claimUnused, releaseClaim }
    );
    await claim?.release();
    expect(releaseClaim).toHaveBeenCalledWith('invite-1', claimUnused.mock.calls[0][1], invite().status);
  });

  it('restores a waiting code to waiting, not open, on release', async () => {
    const releaseClaim = vi.fn();
    const claim = await claimRegistrationInvite(
      { invite: invite({ status: RegInviteStatusType.waiting }), isUnlimited: false },
      { claimUnused: vi.fn().mockResolvedValue(true), releaseClaim }
    );
    await claim?.release();
    expect(releaseClaim).toHaveBeenCalledWith('invite-1', expect.any(Date), RegInviteStatusType.waiting);
  });

  it('returns null when another signup claimed the code first', async () => {
    const claimUnused = vi.fn().mockResolvedValue(false);
    expect(
      await claimRegistrationInvite({ invite: invite(), isUnlimited: false }, { claimUnused, releaseClaim: vi.fn() })
    ).toBeNull();
  });

  it('never claims an unlimited code', async () => {
    const claimUnused = vi.fn();
    expect(
      await claimRegistrationInvite({ invite: invite(), isUnlimited: true }, { claimUnused, releaseClaim: vi.fn() })
    ).not.toBeNull();
    expect(claimUnused).not.toHaveBeenCalled();
  });
});

describe('redeemRegistrationInvite', () => {
  it('closes a single-use code', async () => {
    const update = vi.fn();
    await redeemRegistrationInvite({ invite: invite(), isUnlimited: false }, 'user-1', { update });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'invite-1', usedbyId: 'user-1', status: RegInviteStatusType.used }),
      undefined
    );
  });

  it('keeps an unlimited code open and appends its history', async () => {
    const update = vi.fn();
    const prior = { userId: 'earlier', usedAt: new Date(0) };
    await redeemRegistrationInvite({ invite: invite({ usageHistory: [prior] }), isUnlimited: true }, 'user-1', {
      update,
    });
    const [fields, options] = update.mock.calls[0];
    expect(fields).toEqual({
      id: 'invite-1',
      status: RegInviteStatusType.open,
      usageHistory: [prior, { userId: 'user-1', usedAt: expect.any(Date) }],
    });
    expect(options).toEqual({ unset: ['used', 'usedbyId'] });
  });
});

describe('referralInviteCredits', () => {
  const settings = (settingValue: unknown) => ({ findBySettingName: vi.fn().mockResolvedValue({ settingValue }) });

  it("prefers the invite's own startingCredits over the admin default", async () => {
    const adminSettings = settings('500');
    await expect(referralInviteCredits(invite({ startingCredits: 750 }), adminSettings)).resolves.toBe(750);
    expect(adminSettings.findBySettingName).not.toHaveBeenCalled();
  });

  it('falls back to ReferralCreditsAmount', async () => {
    const adminSettings = settings('500');
    await expect(referralInviteCredits(invite(), adminSettings)).resolves.toBe(500);
    expect(adminSettings.findBySettingName).toHaveBeenCalledWith('ReferralCreditsAmount');
  });

  it.each([[undefined], [''], ['abc'], ['-5'], ['0']])('returns 0 for an unusable setting %j', async value => {
    await expect(referralInviteCredits(invite(), settings(value))).resolves.toBe(0);
  });

  it('returns 0 when the setting is absent', async () => {
    await expect(referralInviteCredits(invite(), { findBySettingName: vi.fn().mockResolvedValue(null) })).resolves.toBe(
      0
    );
  });
});
