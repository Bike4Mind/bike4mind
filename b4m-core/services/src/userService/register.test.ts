import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerUser, registerViaOTC, RegisterUserParameters } from './register';
import { BadRequestError } from '@bike4mind/utils';
import {
  CURRENT_POLICY_VERSION,
  RegInviteSource,
  RegInviteStatusType,
  PENDING_FREE_CREDITS_TAG,
  RESERVED_USERNAME_MESSAGE,
} from '@bike4mind/common';
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
      id: 'invite-1',
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
          findOne: vi.fn().mockResolvedValue(null),
        },
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    };
  });

  it.each([
    [null, 1000, null],
    [1000, 1000, null],
    [2500, 2500, 2500],
  ])('resolves invite quota %s through the shared allocator', async (startingStorage, limit, override) => {
    mockInvite.startingStorage = startingStorage;
    const result = await registerUser(baseParams, mockAdapters);
    expect(result.storageLimit).toBe(limit);
    expect(result.storageLimitOverride).toBe(override);
  });

  it('keeps matched subscriber priority over an invite allocation', async () => {
    mockInvite.email = baseParams.email;
    mockInvite.startingStorage = 2500;
    mockAdapters.db.subscribers = {
      findByEmail: vi.fn().mockResolvedValue({ inviteCode: baseParams.inviteCode, startingStorage: null }),
    };
    const result = await registerUser(baseParams, mockAdapters);
    expect(result.storageLimit).toBe(1000);
    expect(result.storageLimitOverride).toBeNull();
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
    // This path is OTC-only (the sole caller always passes password: ''), so the
    // account is passwordless by construction regardless of what `password` was set to here.
    expect(createdUser.hasUsablePassword).toBe(false);
    expect(mockAdapters.db.registrationInvites.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.registrationInvites.update.mock.calls[0][0]).toStrictEqual({
      id: 'invite-1',
      usageHistory: [{ userId: 'newUserId', usedAt: expect.any(Date) }],
      used: expect.any(Date),
      usedbyId: 'newUserId',
      status: RegInviteStatusType.used,
    });
    const limitedInvite = mockAdapters.db.registrationInvites.update.mock.calls[0][0];
    expect(limitedInvite.used).toBe(limitedInvite.usageHistory[0].usedAt);
    expect(mockAdapters.db.registrationInvites.update.mock.calls[0][1]).toBeUndefined();
  });

  describe('invite-only OTC registration', () => {
    it('redeems an email-bound invite and verifies the account', async () => {
      mockInvite.email = baseParams.email;
      mockAdapters.db.users.update = vi.fn().mockResolvedValue(undefined);
      mockAdapters.db.creditTransactions = undefined;
      const result = await registerViaOTC({ ...baseParams, password: '' }, mockAdapters);
      expect(result).toMatchObject({ email: baseParams.email, emailVerified: true });
      expect(mockAdapters.db.registrationInvites.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockInvite.id, status: RegInviteStatusType.used }),
        undefined
      );
    });

    it.each([
      [{ email: 'other@example.com' }, 'This invite code was issued for a different email address'],
      [{ used: new Date() }, 'Invite code already used'],
      [{ expiresAt: new Date(0) }, 'Invite code has expired'],
    ])('rejects an unusable invite %j', async (patch, message) => {
      Object.assign(mockInvite, patch);
      await expect(registerViaOTC({ ...baseParams, password: '' }, mockAdapters)).rejects.toThrow(message);
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
      expect(mockAdapters.db.registrationInvites.update).not.toHaveBeenCalled();
    });
  });

  describe('reserved username prefix', () => {
    const withSyntheticDomains = (domains: string) => {
      const base = mockAdapters.db.adminSettings.findBySettingName.getMockImplementation();
      mockAdapters.db.adminSettings.findBySettingName.mockImplementation((name: string) =>
        name === 'syntheticUserEmailDomains' ? Promise.resolve({ settingValue: domains }) : base(name)
      );
    };

    it.each([
      'persona-alice',
      'Persona-Alice',
      '  PERSONA-alice',
      '\u0440\u0435rs\u043ena-alice',
      '\uff50ersona-alice',
    ])('rejects %j for an ordinary signup with the reserved-name message', async username => {
      const error = await registerUser({ ...baseParams, username }, mockAdapters).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
      expect((error as Error).message).toBe(RESERVED_USERNAME_MESSAGE);
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('rejects it when the email is on a domain that is not configured as synthetic', async () => {
      withSyntheticDomains('test.example');
      await expect(
        registerUser({ ...baseParams, username: 'persona-alice', email: 'alice@example.com' }, mockAdapters)
      ).rejects.toThrow(RESERVED_USERNAME_MESSAGE);
    });

    it('allows it when the proven email is on a configured synthetic test domain', async () => {
      withSyntheticDomains('@Test.Example, qa.example.org');
      const result = await registerUser(
        { ...baseParams, username: 'persona-alice', email: 'alice@sub.test.example' },
        mockAdapters
      );
      expect(result.username).toBe('persona-alice');
    });

    it('rejects it when the settings read fails', async () => {
      mockAdapters.db.adminSettings.findBySettingName.mockImplementation((name: string) =>
        name === 'syntheticUserEmailDomains' ? Promise.reject(new Error('db down')) : Promise.resolve(null)
      );
      await expect(
        registerUser({ ...baseParams, username: 'persona-alice', email: 'alice@test.example' }, mockAdapters)
      ).rejects.toThrow(RESERVED_USERNAME_MESSAGE);
    });

    it('leaves names that only contain the word alone', async () => {
      const result = await registerUser({ ...baseParams, username: 'personal-site' }, mockAdapters);
      expect(result.username).toBe('personal-site');
    });
  });

  // --- disposable-email blocking ---
  describe('disposable-email blocking', () => {
    it('rejects registration with a disposable-domain email', async () => {
      const params = { ...baseParams, email: 'burner@mailinator.com' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('This email domain is not allowed');
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('rejects a subdomain of a disposable domain', async () => {
      const params = { ...baseParams, email: 'burner@anything.mailinator.com' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('This email domain is not allowed');
    });

    it('rejects disposable domains regardless of email casing', async () => {
      const params = { ...baseParams, email: 'Burner@MAILINATOR.COM' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('This email domain is not allowed');
    });

    it('rejects the fully-qualified (trailing-dot) disposable form', async () => {
      const params = { ...baseParams, email: 'burner@mailinator.com.' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('This email domain is not allowed');
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

    it('rejects an email on an admin-blocked domain even with blockDisposableEmails OFF', async () => {
      mockAdapters.db.adminSettings.findBySettingName = vi.fn().mockImplementation((name: string) => {
        if (name === 'blockedEmailDomains') return Promise.resolve({ settingValue: ['kashre.com'] });
        if (name === 'blockDisposableEmails') return Promise.resolve({ settingValue: 'false' });
        return Promise.resolve(null);
      });
      const params = { ...baseParams, email: 'x@np.kashre.com' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('This email domain is not allowed');
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
    });

    it('rejects a domain on a refreshed reject-tier list carried by db.signupProtection', async () => {
      mockAdapters.db.signupProtection = {
        repository: {
          disposableSources: vi.fn().mockResolvedValue(['curated']),
          isOrganizationDomain: vi.fn().mockResolvedValue(false),
        },
      };
      const params = { ...baseParams, email: 'x@listed-burner.test' };
      await expect(registerUser(params, mockAdapters)).rejects.toThrow('This email domain is not allowed');
      expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
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

  describe('inviter attribution and invite quota', () => {
    const createdUser = () => mockAdapters.db.users.create.mock.calls[0][0];

    it('saves the sender of a referral invite on the new user', async () => {
      mockAdapters.db.registrationInvites.findByCode.mockResolvedValue({
        ...mockInvite,
        email: baseParams.email,
        source: RegInviteSource.referral,
      });
      await registerUser(baseParams, mockAdapters);
      expect(createdUser().referredByUserId).toBe('inviterId');
    });

    it('leaves the inviter unset for an email-bound, non-unlimited invite an admin issued (no referral source)', async () => {
      mockAdapters.db.registrationInvites.findByCode.mockResolvedValue({
        ...mockInvite,
        email: baseParams.email,
        unlimitedUse: false,
      });
      await registerUser(baseParams, mockAdapters);
      expect(createdUser().referredByUserId).toBeNull();
    });

    it('leaves the inviter unset for an admin bulk code (no email)', async () => {
      await registerUser(baseParams, mockAdapters);
      expect(createdUser().referredByUserId).toBeNull();
    });

    it('leaves the inviter unset for an unlimited code, even with an email', async () => {
      mockAdapters.db.registrationInvites.findByCode.mockResolvedValue({
        ...mockInvite,
        email: baseParams.email,
        source: RegInviteSource.referral,
        unlimitedUse: true,
      });
      await registerUser(baseParams, mockAdapters);
      expect(createdUser().referredByUserId).toBeNull();
    });

    it('leaves the inviter unset when there is no invite code', async () => {
      const findBySettingName = mockAdapters.db.adminSettings.findBySettingName;
      mockAdapters.db.adminSettings.findBySettingName = vi
        .fn()
        .mockImplementation((name: string) =>
          name === 'allowOpenRegistration' ? Promise.resolve({ settingValue: true }) : findBySettingName(name)
        );
      await registerUser({ ...baseParams, inviteCode: undefined }, mockAdapters);
      expect(createdUser().referredByUserId).toBeNull();
    });

    it('starts a new user with 3 invites when the setting is unset', async () => {
      await registerUser(baseParams, mockAdapters);
      expect(createdUser().numReferralsAvailable).toBe(3);
    });

    it.each([-1, 2.5, 'abc', 5000])('falls back to 3 invites when ReferralInvitesPerUser is %s', async configured => {
      const findBySettingName = mockAdapters.db.adminSettings.findBySettingName;
      mockAdapters.db.adminSettings.findBySettingName = vi
        .fn()
        .mockImplementation((name: string) =>
          name === 'ReferralInvitesPerUser' ? Promise.resolve({ settingValue: configured }) : findBySettingName(name)
        );
      await registerUser(baseParams, mockAdapters);
      expect(createdUser().numReferralsAvailable).toBe(3);
    });

    it('starts a new user with the configured number of invites, including 0', async () => {
      const findBySettingName = mockAdapters.db.adminSettings.findBySettingName;
      for (const configured of [7, 0]) {
        mockAdapters.db.users.create.mockClear();
        mockAdapters.db.registrationInvites.findByCode.mockResolvedValue({ ...mockInvite });
        mockAdapters.db.adminSettings.findBySettingName = vi
          .fn()
          .mockImplementation((name: string) =>
            name === 'ReferralInvitesPerUser' ? Promise.resolve({ settingValue: configured }) : findBySettingName(name)
          );
        await registerUser(baseParams, mockAdapters);
        expect(createdUser().numReferralsAvailable).toBe(configured);
      }
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

  it('rejects a username outside the allowed characters before any lookup', async () => {
    await expect(registerUser({ ...baseParams, username: '<b>x</b>' }, mockAdapters)).rejects.toThrow(
      "Usernames can contain letters, numbers, spaces and . _ - ' (up to 64 characters)."
    );
    expect(mockAdapters.db.users.findByUsernameOrEmail).not.toHaveBeenCalled();
    expect(mockAdapters.db.users.create).not.toHaveBeenCalled();
  });

  it('stores the username trimmed', async () => {
    await registerUser({ ...baseParams, username: '  testuser  ' }, mockAdapters);

    expect(mockAdapters.db.users.findByUsernameOrEmail).toHaveBeenCalledWith('testuser', baseParams.email);
    expect(mockAdapters.db.users.create).toHaveBeenCalledWith(expect.objectContaining({ username: 'testuser' }));
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

    expect(mockAdapters.db.registrationInvites.update).toHaveBeenCalledTimes(2);
    const updatedUnlimitedInvite = mockAdapters.db.registrationInvites.update.mock.calls.at(-1)?.[0];
    expect(updatedUnlimitedInvite).toStrictEqual({
      id: 'invite-1',
      usageHistory: [
        { userId: 'newUserId', usedAt: expect.any(Date) },
        { userId: 'newUserId', usedAt: expect.any(Date) },
      ],
      status: RegInviteStatusType.open,
    });
    expect(mockAdapters.db.registrationInvites.update.mock.calls.at(-1)?.[1]).toEqual({ unset: ['used', 'usedbyId'] });
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
    expect(mockAdapters.db.registrationInvites.update).toHaveBeenCalledTimes(1);
    const updatedInvite = mockAdapters.db.registrationInvites.update.mock.calls[0][0];
    expect(updatedInvite).toStrictEqual({
      id: 'invite-1',
      usageHistory: [{ userId: 'newUserId', usedAt: expect.any(Date) }],
      used: expect.any(Date),
      usedbyId: 'newUserId',
      status: RegInviteStatusType.used,
    });
    expect(updatedInvite.used).toBe(updatedInvite.usageHistory[0].usedAt);
    expect(mockAdapters.db.registrationInvites.update.mock.calls[0][1]).toBeUndefined();
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

  // --- Open-registration master switch (backend gate + coverage) ---
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

    it('snapshots staged grants only for new no-invite accounts when enabled', async () => {
      setAllowOpenRegistration('true');
      const readSetting = mockAdapters.db.adminSettings.findBySettingName.getMockImplementation();
      mockAdapters.db.adminSettings.findBySettingName.mockImplementation(async (name: string) => {
        const values: Record<string, string> = {
          stagedSignupGrantEnabled: 'true',
          signupGrantCredits: '12',
          verifiedUnlockCredits: '28',
        };
        return name in values ? { settingValue: values[name] } : readSetting(name);
      });
      const result = await registerUser(noInviteParams, mockAdapters);
      expect(result.signupGrant).toEqual({
        stage: 'pending_email',
        signupCredits: 12,
        unlockCredits: 28,
        creditsReleased: 0,
        nextCondition: 'email_verification',
      });
      const invited = await registerUser(baseParams, mockAdapters);
      expect(invited.signupGrant).toBeUndefined();
    });

    describe('invite-code grants under the staged signup grant', () => {
      const enableStaging = () => {
        const readSetting = mockAdapters.db.adminSettings.findBySettingName.getMockImplementation();
        mockAdapters.db.adminSettings.findBySettingName.mockImplementation(async (name: string) => {
          const values: Record<string, string> = {
            stagedSignupGrantEnabled: 'true',
            signupGrantCredits: '4',
            verifiedUnlockCredits: '0',
            ReferralCreditsAmount: '10',
          };
          return name in values ? { settingValue: values[name] } : readSetting(name);
        });
      };
      const created = () => mockAdapters.db.users.create.mock.calls[0][0];
      const referralInvite = (extra: object = {}) => ({
        ...mockInvite,
        email: baseParams.email,
        source: RegInviteSource.referral,
        ...extra,
      });

      it('splits a refer-a-friend flat grant into a tranche plus a locked remainder', async () => {
        enableStaging();
        mockAdapters.db.registrationInvites.findByCode.mockResolvedValue(referralInvite());
        await registerUser(baseParams, mockAdapters);
        expect(created().signupGrant).toMatchObject({ signupCredits: 4, unlockCredits: 6, creditsReleased: 0 });
        expect(created().pendingCreditGrant).toBeNull();
        expect(created().tags).toContain(PENDING_FREE_CREDITS_TAG);
      });

      it('keeps the flat grant for an admin code', async () => {
        enableStaging();
        await registerUser(baseParams, mockAdapters);
        expect(created().signupGrant).toBeUndefined();
        expect(created().pendingCreditGrant).toBe(10);
      });

      it('keeps the flat grant for an unlimited referral-sourced code', async () => {
        enableStaging();
        mockAdapters.db.registrationInvites.findByCode.mockResolvedValue(referralInvite({ unlimitedUse: true }));
        await registerUser(baseParams, mockAdapters);
        expect(created().signupGrant).toBeUndefined();
        expect(created().pendingCreditGrant).toBe(10);
      });

      it('keeps the flat grant for a referral invite when staging is off', async () => {
        mockAdapters.db.registrationInvites.findByCode.mockResolvedValue(referralInvite());
        await registerUser(baseParams, mockAdapters);
        expect(created().signupGrant).toBeUndefined();
        expect(created().pendingCreditGrant).toBe(10);
      });
    });

    it('allows registration when invite check is skipped (OTC \u2014 email already proven)', async () => {
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

// --- registerViaOTC finalizes verification + deferred credit grant ---
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
          claimFreeCreditGrant: vi.fn().mockResolvedValue(true),
          findById: vi.fn().mockResolvedValue(null),
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
          findOne: vi.fn().mockResolvedValue(null),
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
        transactionId: 'verify-grant:newUserId',
      }),
      expect.anything()
    );

    // Email marked verified; pending tag dropped; Customer tag added.
    expect(result.emailVerified).toBe(true);
    expect(result.emailVerifiedAt).toBeInstanceOf(Date);
    expect(result.tags).toContain('Customer');
    expect(result.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    // Exact partial: currentCredits was already $inc-ed by addCredits and must not be rewritten.
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith({
      id: 'newUserId',
      emailVerified: true,
      emailVerifiedAt: expect.any(Date),
      tags: ['Customer'],
      pendingCreditGrant: null,
    });
  });

  it('registers an alias of an already-granted inbox but grants it nothing', async () => {
    mockAdapters.db.users.claimFreeCreditGrant.mockResolvedValue(false);

    const result = await registerViaOTC(otcParams, mockAdapters);

    expect(mockAdapters.db.users.claimFreeCreditGrant).toHaveBeenCalledWith('newUserId');
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(result.emailVerified).toBe(true);
    // The pending tag is released, so the refused grant is not retried on every login.
    expect(result.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
  });

  it('grants the default credits for an admitted no-invite signup while open registration is off', async () => {
    mockAdapters.db.adminSettings.findBySettingName.mockImplementation(async (name: string) => {
      if (name === 'allowOpenRegistration') return { settingValue: false };
      if (name === 'defaultFreeCredits') return { settingValue: '100' };
      return null;
    });

    const result = await registerViaOTC(otcParams, { ...mockAdapters, skipInviteCheck: true });

    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'newUserId', credits: 100, transactionId: 'verify-grant:newUserId' }),
      expect.anything()
    );
    expect(result).toMatchObject({ emailVerified: true, currentCredits: 100 });
    expect(result.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    expect(mockAdapters.db.registrationInvites.findByCode).not.toHaveBeenCalled();
  });

  it('keeps the pending tag (still verifies) when the credit grant throws', async () => {
    mockAddCredits.mockRejectedValueOnce(new Error('credit service down'));
    const result = await registerViaOTC(otcParams, mockAdapters);

    // Grant failed - tag stays as a retry breadcrumb, but the user is still verified/let in.
    expect(result.emailVerified).toBe(true);
    expect(result.tags).toContain(PENDING_FREE_CREDITS_TAG);
    expect(mockAdapters.logger.error).toHaveBeenCalled();
  });

  it('defers the grant when the signup domain is held, through db.signupProtection', async () => {
    mockAdapters.db.users.findById = vi.fn().mockResolvedValue({ id: 'newUserId', email: otcParams.email });
    mockAdapters.db.users.addTagsToUser = vi.fn();
    mockAdapters.db.adminSettings.findBySettingNames = vi.fn().mockResolvedValue([]);
    mockAdapters.db.signupProtection = {
      repository: {
        findReview: vi.fn().mockResolvedValue({ domain: 'example.com', status: 'held_pending_review' }),
        isOrganizationDomain: vi.fn().mockResolvedValue(false),
      },
    };
    const result = await registerViaOTC(otcParams, mockAdapters);

    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(result.emailVerified).toBe(true);
    expect(result.tags).toContain(PENDING_FREE_CREDITS_TAG);
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
        transactionId: 'verify-grant:newUserId',
      }),
      expect.anything()
    );
    expect(result.emailVerified).toBe(true);
    expect(result.tags).not.toContain(PENDING_FREE_CREDITS_TAG);
    // The pending amount must be cleared so it can never be re-granted.
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith({
      id: 'newUserId',
      emailVerified: true,
      emailVerifiedAt: expect.any(Date),
      tags: ['Customer'],
      pendingCreditGrant: null,
    });
  });
  describe('OAuth source tag', () => {
    const activeClient = { clientId: 'b4m_acme_app_0a1b2c3d', isActive: true };
    const sourceTagsOf = () =>
      (mockAdapters.db.users.update.mock.calls[0][0].tags as string[]).filter(t => t.startsWith('source:'));

    it('stamps source:<slug> for an active client and keeps it through the OTC tag rewrite', async () => {
      mockAdapters.db.oauthClients = { findByClientId: vi.fn().mockResolvedValue(activeClient) };
      await registerViaOTC({ ...otcParams, sourceClientId: activeClient.clientId }, mockAdapters);
      expect(mockAdapters.db.oauthClients.findByClientId).toHaveBeenCalledWith(activeClient.clientId);
      expect(sourceTagsOf()).toEqual(['source:acme_app']);
      expect(mockAdapters.db.users.update.mock.calls[0][0].tags).toContain('Customer');
    });

    it('stamps nothing for an inactive client', async () => {
      mockAdapters.db.oauthClients = {
        findByClientId: vi.fn().mockResolvedValue({ ...activeClient, isActive: false }),
      };
      await registerViaOTC({ ...otcParams, sourceClientId: activeClient.clientId }, mockAdapters);
      expect(sourceTagsOf()).toEqual([]);
    });

    it('stamps nothing for an unknown client', async () => {
      mockAdapters.db.oauthClients = { findByClientId: vi.fn().mockResolvedValue(null) };
      await registerViaOTC({ ...otcParams, sourceClientId: 'b4m_nope_0a1b2c3d' }, mockAdapters);
      expect(sourceTagsOf()).toEqual([]);
    });

    it('skips the lookup when no client id is supplied', async () => {
      mockAdapters.db.oauthClients = { findByClientId: vi.fn().mockResolvedValue(activeClient) };
      await registerViaOTC(otcParams, mockAdapters);
      expect(mockAdapters.db.oauthClients.findByClientId).not.toHaveBeenCalled();
      expect(sourceTagsOf()).toEqual([]);
    });

    it('stamps nothing when the caller passes no client lookup', async () => {
      await registerViaOTC({ ...otcParams, sourceClientId: activeClient.clientId }, mockAdapters);
      expect(sourceTagsOf()).toEqual([]);
    });

    it('still creates the user when the client lookup throws', async () => {
      mockAdapters.db.oauthClients = { findByClientId: vi.fn().mockRejectedValue(new Error('db down')) };
      const result = await registerViaOTC({ ...otcParams, sourceClientId: activeClient.clientId }, mockAdapters);
      expect(result).toBeDefined();
      expect(mockAdapters.db.users.create).toHaveBeenCalledTimes(1);
      expect(sourceTagsOf()).toEqual([]);
      expect(mockAdapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining(activeClient.clientId));
    });
  });
});
