import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
const mocks = vi.hoisted(() => ({ claim: vi.fn(), personal: vi.fn(), organization: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository: { claimFreeQuestStart: mocks.claim } }));
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
      additionalInfo: { errorCode: 'free_quest_limit_reached' },
    });
  });
  it('exempts personal and organization-seat subscribers without consuming the allowance', async () => {
    mocks.personal.mockResolvedValue([{ id: 'subscription' }]);
    await expect(admitQuestStart(user, 'first')).resolves.toBe('subscriber');
    await expect(admitQuestStart(user, 'second')).resolves.toBe('subscriber');
    expect(mocks.claim).not.toHaveBeenCalled();
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

  it('applies the durable allowance again after a subscription lapses', async () => {
    mocks.personal.mockResolvedValueOnce([{ id: 'subscription' }]);
    await admitQuestStart(user, 'paid-start');
    mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await admitQuestStart(user, 'first-free');
    await expect(admitQuestStart(user, 'second-free')).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });
});
