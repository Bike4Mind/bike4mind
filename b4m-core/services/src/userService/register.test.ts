import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerUser, registerViaOTC, RegisterUserParameters } from './register';
import { BadRequestError } from '@bike4mind/utils';
import { CURRENT_POLICY_VERSION, RegInviteStatusType, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import * as creditService from '../creditService';

const baseParams: RegisterUserParameters = {
  username: 'testuser',
  email: 'test@example.com',
  name: 'Test User',
  inviteCode: 'INVITE123',
  password: 'password123',
  acceptedPolicyVersion: CURRENT_POLICY_VERSION,
  ageAttestation: true,
  metadata: {
    loginTime: new Date(),
    userAgent: 'test-agent',
    browser: 'Chrome',
    operatingSystem: 'macOS',
    deviceType: 'desktop',
    screenResolution: '1920x1080',
    viewportSize: '1920x1080',
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
    ip: '127.0.0.1',
    location: 'Testland',
  },
};

describe('registerUser', () => {
  let mockAdapters: any;
  let mockInvite: any;
  let mockSettings: any;
  let mockReferralCredits: any;
  let mockAddCredits: any;

  beforeEach(() => {
    vi.resetAllMocks();
    mockInvite = {
      code: 'INVITE123',
      used: null,
      userId: 'inviterId',
      status: RegInviteStatusType.open,
      unlimitedUse: false,
      usageHistory: [],
    };
    mockSettings = { settingValue: 'tag1,tag2' };
    mockReferralCredits = { settingValue: '10' };

    mockAddCredits = vi.fn().mockResolvedValue({ id: 'newUserId', currentCredits: 10 });
    vi.spyOn(creditService, 'addCredits').mockImplementation(mockAddCredits);

    mockAdapters = {
      db: {
        users: {
          findByUsernameOrEmail: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async (user: any) => ({ ...user, id: 'newUserId' })),
          incrementCredits: vi.fn().mockResolvedValue({ id: 'newUserId', currentCredits: 10 }),
        },
        adminSettings: {
          findBySettingName: vi.fn().mockImplementation((name: string) => {
            if (name === 'defaultTags') return Promise.resolve(mockSettings);
            if (name === 'ReferralCreditsAmount') return Promise.resolve(mockReferralCredits);
            return Promise.resolve(null);
          }),
        },
        registrationInvites: {
          findByCode: vi.fn().mockResolvedValue(mockInvite),
          update: vi.fn().mockResolvedValue(undefined),
        },
        creditTransactions: {
          createTransaction: vi.fn().mockResolvedValue({ id: 'transactionId', type: 'generic_add' }),
        },
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    };
  });

  it('registers a new user with valid data and invite, deferring credits until email is proven', async () => {
    const result = await registerUser(baseParams, mockAdapters);
    expect(result).toMatchObject({ username: baseParams.username, email: baseParams.email, name: baseParams.name });
    expect(mockAdapters.db.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: baseParams.username })
    );
    // invite credits are NOT granted at registration - the resolved amount is
    // persisted as a pending grant, released only once email ownership is proven
    // (registerViaOTC immediately, or the email-verify route for legacy flows).
    expect(mockAddCredits).not.toHaveBeenCalled();
    const createdUser = mockAdapters.db.users.create.mock.calls[0][0];
    expect(createdUser.tags).toContain(PENDING_FREE_CREDITS_TAG);
    expect(createdUser.pendingCreditGrant).toBe(10);
    expect(mockAdapters.db.registrationInvites.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: RegInviteStatusType.used,
        usedbyId: 'newUserId',
        usageHistory: [expect.objectContaining({ userId: 'newUserId' })],
      })
    );
  });

  // --- disposable-email blocking ---
  describe('disposable-email blocking', () => {
    it('rejects registration with a disposable-domain email', async () => {
      const params = { ...baseParams, email: 'burner@mailinator.com' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('Disposable email addresses are not allowed');
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('rejects a subdomain of a disposable domain', async () => {
      const params = { ...baseParams, email: 'burner@anything.mailinator.com' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('Disposable email addresses are not allowed');
    });

    it('rejects disposable domains regardless of email casing', async () => {
      const params = { ...baseParams, email: 'Burner@MAILINATOR.COM' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('Disposable email addresses are not allowed');
    });

    it('rejects the fully-qualified (trailing-dot) disposable form', async () => {
      const params = { ...baseParams, email: 'burner@mailinator.com.' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('Disposable email addresses are not allowed');
    });

    it('allows a disposable email when blockDisposableEmails is switched OFF', async () => {
      mockAdapters.db.adminSettings.findBySettingName = vi.fn().mockImplementation((name: string) => {
        if (name === 'defaultTags') return Promise.resolve(mockSettings);
        if (name === 'ReferralCreditsAmount') return Promise.resolve(mockReferralCredits);
        if (name === 'blockDisposableEmails') return Promise.resolve({ settingValue: 'false' });
        return Promise.resolve(null);
      });
      const params = { ...baseParams, email: 'burner@mailinator.com' };
      await expect(registerUser(params, mockAdapters)).resolves.toBeDefined();
    });

    it('rejects a malformed email address', async () => {
      const params = { ...baseParams, email: 'not-an-email' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('Invalid email address');
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });
  });

  // --- invite/credit tie: email-bound invites ---
  describe('email-bound invites', () => {
    it('rejects registration when the invite is bound to a different email', async () => {
      mockAdapters.db.registrationInvites.findByCode.mockResolvedValue({
        ...mockInvite,
        email: 'someone-else@example.com',
      });
      await expect(registerUser(baseParams, mockAdapters)).rejects.toThrow(
        'This invite code was issued for a different email address'
      );
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('accepts when the invite email matches case-insensitively', async () => {
      mockAdapters.db.registrationInvites.findByCode.mockResolvedValue({
        ...mockInvite,
        email: 'Test@Example.COM',
      });
      await expect(registerUser(baseParams, mockAdapters)).resolves.toBeDefined();
    });

    it('does not enforce binding for invites without an email (admin bulk codes)', async () => {
      // default mockInvite has no email field
      await expect(registerUser(baseParams, mockAdapters)).resolves.toBeDefined();
    });
  });

  it('does not tag pending-free-credits when resolved invite credits are 0', async () => {
    mockAdapters.db.adminSettings.findBySettingName = vi.fn().mockImplementation((name: string) => {
      if (name === 'defaultTags') return Promise.resolve(mockSettings);
      if (name === 'ReferralCreditsAmount') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    await registerUser(baseParams, mockAdapters);
    const createdUser = mockAdapters.db.users.create.mock.calls[0][0];
    expect(createdUser.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    expect(createdUser.pendingCreditGrant).toBeNull();
  });

  it('throws if username or email already exists', async () => {
    mockAdapters.db.users.findByUsernameOrEmail.mockResolvedValue({
      username: baseParams.username,
      email: baseParams.email,
    });
    await expect(registerUser(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
  });

  it('throws if invite code is invalid', async () => {
    mockAdapters.db.registrationInvites.findByCode.mockResolvedValue(null);
    await expect(registerUser(baseParams, mockAdapters)).rejects.toThrow('Invalid invite code');
  });

  it('throws if invite code is already used', async () => {
    mockAdapters.db.registrationInvites.findByCode.mockResolvedValue({ ...mockInvite, used: new Date() });
    await expect(registerUser(baseParams, mockAdapters)).rejects.toThrow('Invite code already used');
  });

  it('throws if invite code has expired', async () => {
    const expiredInvite = {
      ...mockInvite,
      expiresAt: new Date(Date.now() - 60_000),
    };
    mockAdapters.db.registrationInvites.findByCode.mockResolvedValue(expiredInvite);

    await expect(registerUser(baseParams, mockAdapters)).rejects.toThrow('Invite code has expired');
  });

  it('allows reuse when invite is unlimited', async () => {
    const unlimitedInvite = {
      ...mockInvite,
      unlimitedUse: true,
      expiresAt: new Date(Date.now() + 60_000),
    };

    mockAdapters.db.registrationInvites.findByCode.mockResolvedValue(unlimitedInvite);

    await registerUser(baseParams, mockAdapters);

    const reuseParams: RegisterUserParameters = {
      ...baseParams,
      username: 'secondUser',
      email: 'second@example.com',
    };

    mockAdapters.db.users.findByUsernameOrEmail
      .mockResolvedValueOnce(null) // for second run username/email check
      .mockResolvedValueOnce(null);

    await expect(registerUser(reuseParams, mockAdapters)).resolves.toBeDefined();

    const updatedUnlimitedInvite = mockAdapters.db.registrationInvites.update.mock.calls.at(-1)?.[0];
    expect(updatedUnlimitedInvite?.status).toBe(RegInviteStatusType.open);
    expect(updatedUnlimitedInvite?.used).toBeUndefined();
    expect(updatedUnlimitedInvite?.usedbyId).toBeUndefined();
    expect(updatedUnlimitedInvite?.usageHistory?.length).toBe(2);
  });

  it('applies default tags if present', async () => {
    await registerUser(baseParams, mockAdapters);
    const createdUser = mockAdapters.db.users.create.mock.calls[0][0];
    // The pending-free-credits tag is expected too; invite credits defer.
    expect(createdUser.tags).toEqual(['tag1', 'tag2', PENDING_FREE_CREDITS_TAG]);
  });

  it('sets freeCredits to 0 if referralCredits setting is missing', async () => {
    mockAdapters.db.adminSettings.findBySettingName = vi.fn().mockImplementation((name: string) => {
      if (name === 'defaultTags') return Promise.resolve(mockSettings);
      if (name === 'ReferralCreditsAmount') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    await registerUser(baseParams, mockAdapters);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('marks invite as used and updates status', async () => {
    await registerUser(baseParams, mockAdapters);
    const updatedInvite = mockAdapters.db.registrationInvites.update.mock.calls[0][0];
    expect(updatedInvite.used).toBeInstanceOf(Date);
    expect(updatedInvite.status).toBe(RegInviteStatusType.used);
    expect(updatedInvite.usageHistory?.length).toBe(1);
  });

  // P0-B abuse gate: server-side enforcement, independent of the UI checkboxes.
  describe('AUP/ToS acceptance + age gate', () => {
    it('rejects creation when the accepted policy version is absent', async () => {
      const { acceptedPolicyVersion, ...missing } = baseParams;
      await expect(registerUser(missing as RegisterUserParameters, mockAdapters)).rejects.toThrow(BadRequestError);
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('rejects creation when the accepted policy version is not current', async () => {
      await expect(
        registerUser({ ...baseParams, acceptedPolicyVersion: 'stale-version' }, mockAdapters)
      ).rejects.toThrow(BadRequestError);
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('rejects creation when the 18+ attestation is not true', async () => {
      await expect(
        registerUser({ ...baseParams, ageAttestation: false as unknown as true }, mockAdapters)
      ).rejects.toThrow(BadRequestError);
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('persists the policy version, acceptance timestamp, and age flag on the new user', async () => {
      await registerUser(baseParams, mockAdapters);
      const createdUser = mockAdapters.db.users.create.mock.calls[0][0];
      expect(createdUser.aupAcceptedVersion).toBe(CURRENT_POLICY_VERSION);
      expect(createdUser.aupAcceptedAt).toBeInstanceOf(Date);
      expect(createdUser.ageAttestedAdult).toBe(true);
    });
  });

  // --- Open-registration master switch (P1-3 backend gate / P1-6 coverage) ---
  describe('open registration gate (no invite code)', () => {
    const noInviteParams: RegisterUserParameters = { ...baseParams, inviteCode: undefined };

    const setAllowOpenRegistration = (value: 'true' | 'false') => {
      mockAdapters.db.adminSettings.findBySettingName = vi.fn().mockImplementation((name: string) => {
        if (name === 'defaultTags') return Promise.resolve(mockSettings);
        if (name === 'ReferralCreditsAmount') return Promise.resolve(mockReferralCredits);
        if (name === 'allowOpenRegistration') return Promise.resolve({ settingValue: value });
        return Promise.resolve(null);
      });
    };

    it('throws when open registration is OFF and no invite code is supplied', async () => {
      setAllowOpenRegistration('false');
      await expect(registerUser(noInviteParams, mockAdapters)).rejects.toThrow(
        'An invite code is required to register'
      );
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('allows registration when open registration is ON, deferring free credits', async () => {
      setAllowOpenRegistration('true');
      const result = await registerUser(noInviteParams, mockAdapters);

      // User is created and tagged pending-free-credits; no credits granted at registration.
      const createdUser = mockAdapters.db.users.create.mock.calls[0][0];
      expect(createdUser.tags).toContain(PENDING_FREE_CREDITS_TAG);
      expect(mockAddCredits).not.toHaveBeenCalled();
      expect(result).toMatchObject({ email: noInviteParams.email });
    });

    it('allows registration when invite check is skipped (OTC — email already proven)', async () => {
      setAllowOpenRegistration('false');
      const result = await registerUser(noInviteParams, { ...mockAdapters, skipInviteCheck: true });
      expect(result).toMatchObject({ email: noInviteParams.email });
      expect(mockAdapters.db.users.create).toHaveBeenCalled();
    });
  });

  // --- P2-4: concurrent-registration E11000 -> clean error ---
  it('surfaces a clean error when create hits the unique-email index (E11000)', async () => {
    mockAdapters.db.users.create = vi.fn().mockRejectedValue({ code: 11000 });
    await expect(registerUser(baseParams, mockAdapters)).rejects.toThrow('Email already in use');
  });
});

// --- P1-6: registerViaOTC finalizes verification + deferred credit grant ---
describe('registerViaOTC', () => {
  let mockAdapters: any;
  let mockAddCredits: any;

  beforeEach(() => {
    vi.resetAllMocks();
    mockAddCredits = vi.fn().mockResolvedValue({ id: 'newUserId', currentCredits: 100 });
    vi.spyOn(creditService, 'addCredits').mockImplementation(mockAddCredits);

    mockAdapters = {
      db: {
        users: {
          findByUsernameOrEmail: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async (user: any) => ({ ...user, id: 'newUserId' })),
          update: vi.fn().mockImplementation(async (user: any) => user),
        },
        adminSettings: {
          findBySettingName: vi.fn().mockImplementation((name: string) => {
            if (name === 'defaultTags') return Promise.resolve({ settingValue: '' });
            if (name === 'allowOpenRegistration') return Promise.resolve({ settingValue: 'true' });
            if (name === 'defaultFreeCredits') return Promise.resolve({ settingValue: '100' });
            return Promise.resolve(null);
          }),
        },
        registrationInvites: { findByCode: vi.fn().mockResolvedValue(null), update: vi.fn() },
        creditTransactions: {
          createTransaction: vi.fn().mockResolvedValue({ id: 'transactionId', type: 'generic_add' }),
        },
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    };
  });

  const otcParams: RegisterUserParameters = {
    username: 'otcuser',
    email: 'otc@example.com',
    name: 'OTC User',
    inviteCode: undefined,
    password: '',
    // P0-B abuse gate: the OTC register form collects acceptance before the code is
    // sent, so registerViaOTC receives these and the account is gated at creation like every path.
    acceptedPolicyVersion: CURRENT_POLICY_VERSION,
    ageAttestation: true,
  };

  it('grants deferred free credits, verifies email, and drops the pending tag', async () => {
    const result = await registerViaOTC(otcParams, mockAdapters);

    // Deferred credits granted with an idempotent, user-keyed transactionId.
    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'newUserId',
        credits: 100,
        transactionId: 'otc-register-grant:newUserId',
      }),
      expect.anything()
    );

    // Email marked verified; pending tag dropped; Customer tag added.
    expect(result.emailVerified).toBe(true);
    expect(result.emailVerifiedAt).toBeInstanceOf(Date);
    expect(result.tags).toContain('Customer');
    expect(result.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: true }));
  });

  it('keeps the pending tag (still verifies) when the credit grant throws', async () => {
    mockAddCredits.mockRejectedValueOnce(new Error('credit service down'));
    const result = await registerViaOTC(otcParams, mockAdapters);

    // Grant failed - tag stays as a retry breadcrumb, but the user is still verified/let in.
    expect(result.emailVerified).toBe(true);
    expect(result.tags).toContain(PENDING_FREE_CREDITS_TAG);
    expect(mockAdapters.logger.error).toHaveBeenCalled();
  });

  // P0-B abuse gate: OTC is now the primary new-signup surface (the password
  // register endpoint was removed). Prove the creation-time gate fires on this path too - the
  // route mocks registerViaOTC, so this service-level test is where the enforcement is verified.
  it('rejects OTC creation when the versioned acceptance is absent', async () => {
    const { acceptedPolicyVersion, ...missing } = otcParams;
    await expect(registerViaOTC(missing as RegisterUserParameters, mockAdapters)).rejects.toThrow(BadRequestError);
    expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
  });

  it('rejects OTC creation when the 18+ attestation is not true', async () => {
    await expect(
      registerViaOTC({ ...otcParams, ageAttestation: false as unknown as true }, mockAdapters)
    ).rejects.toThrow(BadRequestError);
    expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
  });

  // --- invite-resolved pending grant is released immediately (OTC proved the email) ---
  it('grants the invite-resolved pending amount (not defaultFreeCredits) and clears the field', async () => {
    mockAdapters.db.registrationInvites.findByCode = vi.fn().mockResolvedValue({
      code: 'INVITE500',
      email: 'otc@example.com',
      startingCredits: 500,
      status: RegInviteStatusType.open,
      usageHistory: [],
    });

    const result = await registerViaOTC({ ...otcParams, inviteCode: 'INVITE500' }, mockAdapters);

    // The invite amount (500) wins over the defaultFreeCredits setting (100).
    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'newUserId',
        credits: 500,
        transactionId: 'otc-register-grant:newUserId',
      }),
      expect.anything()
    );
    expect(result.emailVerified).toBe(true);
    expect(result.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    // The pending amount must be cleared so it can never be re-granted.
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ pendingCreditGrant: null }));
  });
});
