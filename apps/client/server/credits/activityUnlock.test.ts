import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ unlock: vi.fn(), protection: { repository: {} } }));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: h.protection }));
vi.mock('@bike4mind/services', () => ({ userService: { unlockSignupGrant: h.unlock } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  Quest: {},
  userRepository: {},
}));

import { unlockSignupGrantFromActivity } from './activityUnlock';

describe('activity signup unlock', () => {
  it('passes the shared domain protection to the staged release', async () => {
    h.unlock.mockResolvedValue({ creditsGranted: 0, currentCredits: null });
    await unlockSignupGrantFromActivity('user-1');
    expect(h.unlock).toHaveBeenCalledWith('user-1', 'activity', expect.anything());
    expect(h.unlock.mock.calls[0][2].db.signupProtection).toBe(h.protection);
  });
});
