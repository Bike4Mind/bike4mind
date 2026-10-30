import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ organization: vi.fn(), activity: vi.fn() }));
vi.mock('./orgInviteUnlock', () => ({ unlockSignupGrantFromAcceptedOrgInvite: mocks.organization }));
vi.mock('./activityUnlock', () => ({ unlockSignupGrantFromActivity: mocks.activity }));
import { checkSignupGrantEligibility } from './signupGrantEligibility';

describe('signup grant eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organization.mockResolvedValue({ creditsGranted: 0, currentCredits: null });
    mocks.activity.mockResolvedValue({ creditsGranted: 0, currentCredits: null });
  });

  it('retries accepted organization evidence before activity and returns its successful release', async () => {
    mocks.organization.mockResolvedValue({ creditsGranted: 28, currentCredits: 40 });
    expect(await checkSignupGrantEligibility('user-1')).toEqual({ creditsGranted: 28, currentCredits: 40 });
    expect(mocks.organization).toHaveBeenCalledExactlyOnceWith('user-1');
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('checks activity when organization evidence does not release a grant', async () => {
    mocks.activity.mockResolvedValue({ creditsGranted: 28, currentCredits: 40 });
    expect(await checkSignupGrantEligibility('user-1')).toEqual({ creditsGranted: 28, currentCredits: 40 });
    expect(mocks.activity).toHaveBeenCalledExactlyOnceWith('user-1');
  });

  it('leaves an evidence-read failure retryable', async () => {
    mocks.organization.mockRejectedValueOnce(new Error('temporary database failure'));
    await expect(checkSignupGrantEligibility('user-1')).rejects.toThrow('temporary database failure');
    expect(mocks.activity).not.toHaveBeenCalled();
    mocks.organization.mockResolvedValueOnce({ creditsGranted: 28, currentCredits: 40 });
    expect((await checkSignupGrantEligibility('user-1')).creditsGranted).toBe(28);
  });
});
