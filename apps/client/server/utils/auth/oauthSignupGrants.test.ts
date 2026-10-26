import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApplySignupDomainGrant = vi.fn();
vi.mock('@server/entitlements/signupDomainGrant', () => ({
  applySignupDomainGrant: (...a: unknown[]) => mockApplySignupDomainGrant(...a),
}));

const mockLoggerError = vi.fn();
vi.mock('@bike4mind/observability', () => ({
  Logger: { globalInstance: { info: vi.fn(), error: (...a: unknown[]) => mockLoggerError(...a) } },
}));

import { applyOAuthSignupDomainGrant } from './oauthSignupGrants';

describe('applyOAuthSignupDomainGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the shared domain grant with the oauth-signup trigger', async () => {
    const grant = { creditsGranted: 25, subscriptionCreditsGranted: 10 };
    mockApplySignupDomainGrant.mockResolvedValue(grant);

    await expect(applyOAuthSignupDomainGrant('user-1', 'dee@partner.example')).resolves.toBe(grant);

    expect(mockApplySignupDomainGrant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', email: 'dee@partner.example', trigger: 'oauth-signup' })
    );
  });

  it('logs with the user id and never throws', async () => {
    mockApplySignupDomainGrant.mockRejectedValue(new Error('boom'));

    await expect(applyOAuthSignupDomainGrant('user-1', 'dee@partner.example')).resolves.toMatchObject({
      creditsGranted: 0,
      subscriptionCreditsGranted: 0,
    });
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
  });
});
