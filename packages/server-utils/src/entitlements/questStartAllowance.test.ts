import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  personal: vi.fn(),
  organization: vi.fn(),
  lapsed: vi.fn(),
  orgIds: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { claimFreeQuestStart: mocks.claim },
  organizationRepository: { findPlanHolderOrgIds: mocks.orgIds },
}));
vi.mock('../models/Subscription', () => ({
  subscriptionRepository: { hasLapsedSubscriptionsByOwners: mocks.lapsed },
}));
vi.mock('./activeSubscriptions', () => ({
  getActiveSubscriptionsForUser: mocks.personal,
  getActiveSubscriptionsForOrganization: mocks.organization,
}));
import { admitQuestStart } from './questStartAllowance';

const user = { id: 'user' } as IUserDocument;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.personal.mockResolvedValue([]);
  mocks.organization.mockResolvedValue([]);
  mocks.claim.mockResolvedValue(true);
  mocks.lapsed.mockResolvedValue(false);
  mocks.orgIds.mockResolvedValue([]);
});

describe('admitQuestStart', () => {
  it('claims the first free start', async () => {
    await expect(admitQuestStart(user, 'start')).resolves.toBe('free');
    expect(mocks.claim).toHaveBeenCalledWith('user', 'start');
    expect(mocks.personal).toHaveBeenCalledWith('user', { strict: true });
  });
  it('returns a typed refusal for a second free start', async () => {
    mocks.claim.mockResolvedValue(false);
    await expect(admitQuestStart(user, 'second')).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Turn QuestMaster off (enableQuestMaster=false) to continue chatting'),
      additionalInfo: { errorCode: 'free_quest_limit_reached' },
    });
  });
  it('exempts personal and organization-seat subscribers without consuming the allowance', async () => {
    mocks.personal.mockResolvedValue([{ id: 'subscription' }]);
    await expect(admitQuestStart(user, 'first')).resolves.toBe('subscriber');
    await expect(admitQuestStart(user, 'second')).resolves.toBe('subscriber');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.lapsed).not.toHaveBeenCalled();
  });
  it('uses the owning organization for service accounts', async () => {
    mocks.organization.mockResolvedValue([{ id: 'subscription' }]);
    await admitQuestStart({ ...user, serviceAccountOrganizationId: 'org' }, 'start');
    expect(mocks.organization).toHaveBeenCalledWith('org');
    expect(mocks.personal).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('does not consume an allowance when subscription lookup fails', async () => {
    mocks.personal.mockRejectedValue(new Error('unavailable'));
    await expect(admitQuestStart(user, 'start')).rejects.toThrow('unavailable');
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('refuses a lapsed subscriber without consuming an unused trial', async () => {
    mocks.personal.mockResolvedValueOnce([{ id: 'subscription' }]);
    await admitQuestStart(user, 'paid-start');
    mocks.lapsed.mockResolvedValue(true);
    await expect(admitQuestStart(user, 'after-lapse')).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('You can still read and export existing quests'),
      additionalInfo: { errorCode: 'free_quest_limit_reached' },
    });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('refuses a seat member whose organization plan lapsed', async () => {
    mocks.orgIds.mockResolvedValue(['org']);
    mocks.lapsed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(admitQuestStart(user, 'after-lapse')).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.lapsed).toHaveBeenNthCalledWith(1, 'User', ['user']);
    expect(mocks.lapsed).toHaveBeenNthCalledWith(2, 'Organization', ['org']);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('refuses a service account whose owning organization plan lapsed', async () => {
    mocks.lapsed.mockResolvedValue(true);
    await expect(admitQuestStart({ ...user, serviceAccountOrganizationId: 'org' }, 'start')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.lapsed).toHaveBeenCalledWith('Organization', ['org']);
    expect(mocks.orgIds).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it.each(['history', 'membership'])('does not consume a trial when the %s lookup fails', async lookup => {
    const error = new Error('unavailable');
    if (lookup === 'history') mocks.lapsed.mockRejectedValue(error);
    else mocks.orgIds.mockRejectedValue(error);
    await expect(admitQuestStart(user, 'start')).rejects.toBe(error);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
