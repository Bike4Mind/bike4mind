import {
  IAdminSettingsRepository,
  ICreditLotRepository,
  ICreditTransactionRepository,
  newSignupGrant,
  IUserDocument,
  IUserRepository,
  type SignupProtection,
} from '@bike4mind/common';
import { IRegInviteDocument, RegInviteSource, RegInviteStatusType, RepositoryUpdateOptions } from '@bike4mind/common';
import { ISubscriberRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import {
  CURRENT_POLICY_VERSION,
  DEFAULT_STORAGE_LIMIT_MB,
  resolveUserStorageLimit,
  PENDING_FREE_CREDITS_TAG,
  settingsMap,
  USERNAME_RULES_MESSAGE,
  usernameSchema,
} from '@bike4mind/common';
import { type FreeCreditAdapters, releasePendingFreeCredits } from './freeCredits';
import { shouldBlockDisposableEmail } from './disposableEmail';
import { OAuthSourceClientLookup, resolveOAuthSourceTag } from './sourceTag';
import { assertUsernameNotReserved } from './reservedUsername';

// NOT parsed at runtime - derives the param type via z.infer only. The policy/age fields are
// enforced by the manual `!== true` / version checks in registerUser below, not by this schema.
// Adding a field here does NOT enforce it until you validate it at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used only as type via z.infer
const registerUserSchema = z.object({
  username: z.string(),
  email: z.string(),
  name: z.string(),
  inviteCode: z.string().optional(),
  // client_id of the OAuth client the signup came through; resolved to a source:<slug> tag only
  // when it names an active registered client.
  sourceClientId: z.string().optional(),
  password: z.string().optional().default(''),
  // P0-B abuse gate: a new account cannot be created without a versioned AUP/ToS
  // acceptance and an 18+ age attestation. Enforced HERE in the service (not just the UI form) so
  // a direct API call that omits them is rejected. `z.literal(true)` rejects `false`/absent.
  acceptedPolicyVersion: z.string(),
  ageAttestation: z.literal(true),
  metadata: z
    .object({
      loginTime: z.date(),
      userAgent: z.string(),
      browser: z.string(),
      operatingSystem: z.string(),
      deviceType: z.string(),
      screenResolution: z.string(),
      viewportSize: z.string(),
      colorDepth: z.number(),
      pixelDepth: z.number(),
      devicePixelRatio: z.number(),
      ip: z.string().prefault(''),
      location: z.string().optional(),
    })
    .optional(),
});

export type RegisterUserParameters = z.infer<typeof registerUserSchema>;

interface RegisterUserAdapters {
  db: {
    users: IUserRepository;
    signupProtection?: SignupProtection;
    adminSettings: IAdminSettingsRepository;
    registrationInvites: {
      findByCode: (code: string) => Promise<IRegInviteDocument | null>;
      update: (
        invite: Partial<IRegInviteDocument>,
        options?: RepositoryUpdateOptions<IRegInviteDocument>
      ) => Promise<unknown>;
    };
    subscribers?: ISubscriberRepository;

    /**
     * creditTransactions are required if you need credits to be added
     * to the user
     */
    creditTransactions?: ICreditTransactionRepository;
    oauthClients?: OAuthSourceClientLookup;
    creditLots?: ICreditLotRepository;
  };
  logger: Logger;
  /**
   * When true, skip the invite-code / open-registration check.
   * Used by OTC registration where email ownership is already verified.
   */
  skipInviteCheck?: boolean;
  /** Forwarded to the staged signup grant's first assessment (see FreeCreditAdapters). */
  collectRiskSignals?: FreeCreditAdapters['collectRiskSignals'];
}

export const registerUser = async (
  params: RegisterUserParameters,
  { db, logger, skipInviteCheck }: RegisterUserAdapters
) => {
  const { email, name, inviteCode, password, metadata, acceptedPolicyVersion, ageAttestation, sourceClientId } = params;

  // P0-B abuse gate: reject creation unless a current, versioned AUP/ToS acceptance
  // and an 18+ attestation are present. This is the server-side enforcement - the UI checkboxes
  // are necessary but insufficient (a direct API call bypasses them). Validated explicitly here
  // because registerUserSchema is used only as a type (z.infer), not parsed at runtime.
  if (acceptedPolicyVersion !== CURRENT_POLICY_VERSION) {
    throw new BadRequestError('You must accept the current Terms of Service and Acceptable Use Policy to register');
  }
  if (ageAttestation !== true) {
    throw new BadRequestError('You must confirm you are 18 or older to register');
  }

  const parsedUsername = usernameSchema.safeParse(params.username);
  if (!parsedUsername.success) {
    throw new BadRequestError(USERNAME_RULES_MESSAGE);
  }
  const username = parsedUsername.data;

  // shape-check the email before any DB work. Ownership is proven by OTC, so
  // this only rejects junk input - same light regex as /api/otc/send. Normalization is
  // for the checks below only; the stored email keeps the caller's casing.
  const normalizedEmail = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new BadRequestError('Invalid email address');
  }

  // The only caller, registerViaOTC, runs after the code proved the email.
  await assertUsernameNotReserved(username, normalizedEmail, db.adminSettings);

  const existingUser = await db.users.findByUsernameOrEmail(username, email);
  if (existingUser) {
    const field = existingUser.username === username ? 'username' : 'email';
    throw new BadRequestError(`This ${field} is already registered`);
  }

  // anti-sybil: refuse throwaway inboxes at the chokepoint every credit-bearing
  // registration flows through. Self-serve OAuth signup (verifyCallback.ts) refuses on the
  // same shouldBlockDisposableEmail gate; Okta/SAML signup and admin user creation grant no
  // flat credits. Registration-only - OTC sign-in for existing accounts never reaches this
  // function, so grandfathered users on such domains are unaffected.
  if (
    await shouldBlockDisposableEmail(normalizedEmail, {
      adminSettings: db.adminSettings,
      signupProtection: db.signupProtection,
    })
  ) {
    throw new BadRequestError('This email domain is not allowed');
  }

  let tags: string[] = [];
  const settings = await db.adminSettings.findBySettingName('defaultTags');
  const referralCredits = await db.adminSettings.findBySettingName('ReferralCreditsAmount');
  if (settings) {
    tags = settings.settingValue
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);
  }

  // Resolve the invite (if any) and the free-credit / storage grant. Two paths:
  //   - invite path - validate the code, resolve subscriber/invite/admin credits. The
  //     resolved amount is NOT granted here: it is persisted as
  //     `pendingCreditGrant` + the pending-free-credits tag and released only once email
  //     ownership is proven. releasePendingFreeCredits (freeCredits.ts) does the release on
  //     every path: OTC registration (registerViaOTC), email-link verify (/api/email/verify),
  //     first OTC login (/api/otc/verify), OAuth signup and promote-on-link
  //     (verifyCallback.ts, okta/callback.ts), and the backfillPendingFreeCredits script.
  //   - open-registration path - gated behind the `allowOpenRegistration` master switch
  //     (default OFF, so existing invite-only behavior is preserved exactly). When enabled,
  //     no code is needed; the `defaultFreeCredits` grant is DEFERRED the same way (tag
  //     only, no pendingCreditGrant - the amount is read from settings at grant time).
  //   Either way no unverified account ever holds credits. This is safe because the
  //     pre-request credit reservation in ChatCompletionProcess makes it impossible to spend
  //     beyond the credits eventually granted - a free user's hard ceiling is their balance.
  // Parse through the Zod schema so the read accepts both the JS boolean form the admin UI
  // persists today AND any legacy string-encoded value - `=== 'true'` alone would silently
  // miss the boolean form and leave the master switch permanently OFF.
  const allowOpenRegistrationSetting = await db.adminSettings.findBySettingName('allowOpenRegistration');
  const allowOpenRegistrationParsed = settingsMap.allowOpenRegistration.schema.safeParse(
    allowOpenRegistrationSetting?.settingValue
  );
  const allowOpenRegistration = allowOpenRegistrationParsed.success ? allowOpenRegistrationParsed.data : false;
  const hasInviteCode = typeof inviteCode === 'string' && inviteCode.trim().length > 0;
  const normalizedInviteCode = hasInviteCode ? inviteCode!.trim() : '';

  let invite: IRegInviteDocument | null = null;
  let isUnlimitedInvite = false;
  let freeCredits = 0;
  let storageLimitOverride: number | null = null;

  if (hasInviteCode) {
    invite = await db.registrationInvites.findByCode(normalizedInviteCode);
    if (!invite) throw new BadRequestError('Invalid invite code');
    isUnlimitedInvite = Boolean(invite.unlimitedUse);
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestError('Invite code has expired');
    }
    if (invite.used && !isUnlimitedInvite) throw new BadRequestError('Invite code already used');

    // an invite issued to a specific inbox is redeemable only by that inbox -
    // referral invites (refer.ts) always carry the target email, so a leaked/forwarded
    // code can't move its credit grant to a different account. Admin bulk codes have
    // no email and stay freely redeemable.
    if (invite.email && invite.email.toLowerCase().trim() !== normalizedEmail) {
      throw new BadRequestError('This invite code was issued for a different email address');
    }

    // Merge invite-code-specific tags with admin default tags
    if (invite.tags && invite.tags.length > 0) {
      tags = [...new Set([...tags, ...invite.tags])];
    }

    // Check if this invite is associated with a subscriber for custom credits/storage
    let subscriberCredits = 0;
    let subscriberStorage = DEFAULT_STORAGE_LIMIT_MB; // Default storage
    let subscriberStorageFound = false;

    if (invite.email && db.subscribers) {
      try {
        const subscriber = await db.subscribers.findByEmail(invite.email);
        if (subscriber && subscriber.inviteCode === normalizedInviteCode) {
          // Use subscriber-specific allocations if available
          subscriberCredits = subscriber.startingCredits || 0;
          subscriberStorage = subscriber.startingStorage || DEFAULT_STORAGE_LIMIT_MB;
          subscriberStorageFound = true;
          logger.info(
            `Applying subscriber-specific allocations: ${subscriberCredits} credits, ${subscriberStorage}MB storage for ${email}`
          );
        }
      } catch (error) {
        logger.warn(`Could not check subscriber allocations for ${email}: ${error}`);
        // Continue with default values if subscriber lookup fails
      }
    }

    // Invite code credits/storage (set when generating the code)
    const inviteCredits = invite.startingCredits || 0;
    const inviteStorage = invite.startingStorage || 0;

    // Priority: subscriber > invite code > admin default
    freeCredits =
      subscriberCredits > 0
        ? subscriberCredits
        : inviteCredits > 0
          ? inviteCredits
          : (parseInt(referralCredits?.settingValue || '0', 10) ?? 0);

    // Priority: subscriber > invite code > default (1000)
    const signupStorage = subscriberStorageFound ? subscriberStorage : inviteStorage > 0 ? inviteStorage : null;
    storageLimitOverride = signupStorage === DEFAULT_STORAGE_LIMIT_MB ? null : signupStorage;
  } else {
    // No invite code - only permitted when open registration is enabled or invite check is skipped
    // (e.g., OTC registration where email ownership is already verified).
    if (!allowOpenRegistration && !skipInviteCheck) {
      throw new BadRequestError('An invite code is required to register');
    }
    // Subscriber-specific allocations (`db.subscribers.findByEmail`) are intentionally NOT
    // consulted here: that path requires an invite-code linkage. A known subscriber who
    // self-serves with no code gets the default free-credit grant, not their custom one.
    // Anti-spam: do NOT grant free credits at registration. A throwaway email could otherwise
    // burn the grant with no real inbox behind it. Defer the grant until the user verifies their
    // email (granted in /api/email/verify); mark the account as awaiting it. freeCredits stays 0.
    tags = [...new Set([...tags, PENDING_FREE_CREDITS_TAG])];
    storageLimitOverride = null;
    logger.info(`Open registration (no invite) for ${email}: free credits deferred until email verification`);
  }

  // invite-resolved credits are deferred behind the same pending tag as the
  // open-registration grant; the amount travels on the user doc.
  if (freeCredits > 0) {
    tags = [...new Set([...tags, PENDING_FREE_CREDITS_TAG])];
  }

  // Attribution must never block a signup, so a failed lookup only drops the tag.
  if (sourceClientId && db.oauthClients) {
    try {
      const sourceTag = await resolveOAuthSourceTag(sourceClientId, db.oauthClients);
      if (sourceTag) tags = [...new Set([...tags, sourceTag])];
    } catch (error) {
      logger.warn(`Could not resolve OAuth source tag for client ${sourceClientId}: ${error}`);
    }
  }

  // Only an invite a user sent through the refer flow names an inviter. Admin bulk codes,
  // admin-issued subscriber invites and unlimited codes have no sender to credit, and invites
  // minted before `source` existed are deliberately not attributed.
  const referredByUserId =
    invite && !isUnlimitedInvite && invite.source === RegInviteSource.referral && invite.userId ? invite.userId : null;

  const invitesPerUserSetting = await db.adminSettings.findBySettingName('ReferralInvitesPerUser');
  const invitesPerUserParsed = settingsMap.ReferralInvitesPerUser.schema.safeParse(invitesPerUserSetting?.settingValue);
  const numReferralsAvailable = invitesPerUserParsed.success
    ? invitesPerUserParsed.data
    : settingsMap.ReferralInvitesPerUser.schema.parse(undefined);

  const buildUser: Omit<IUserDocument, 'id'> = {
    username,
    email,
    name,
    password: password ? await hashPassword(password) : null,
    // This registration path is OTC-only (the only caller, registerViaOTC, always
    // passes password: ''), so the account is passwordless by construction.
    hasUsablePassword: false,
    tags: tags ?? null,
    systemFiles: [],
    mementos: [],

    // P0-B: record the versioned policy acceptance + 18+ attestation on the account.
    aupAcceptedVersion: CURRENT_POLICY_VERSION,
    aupAcceptedAt: new Date(),
    ageAttestedAdult: true,

    // DEFAULT VALUES
    groups: [],
    isAdmin: false,
    storageLimit: resolveUserStorageLimit({ storageLimitOverride }).limitMb,
    storageLimitOverride,
    planStorageLimit: null,
    currentStorageSize: 0,
    currentCredits: 0,
    pendingCreditGrant: freeCredits > 0 ? freeCredits : null,
    ...(!hasInviteCode ? { signupGrant: await newSignupGrant(db.adminSettings) } : {}),
    level: 'DemoUser',
    isBanned: false,
    isModerated: false,
    subscribedUntil: null,
    oauthCredentials: null,
    authProviders: [],
    atlassianConnect: null,
    notionConnect: null,
    lastNotebookId: null,
    mfa: null,
    team: null,
    role: null,
    phone: null,
    preferredLanguage: null,
    preferredContact: null,
    tshirtSize: null,
    geoLocation: null,
    securityQuestions: null,
    userNotes: null,
    loginRecords: metadata ? [metadata] : [],
    resetPasswordToken: null,
    resetPasswordSentAt: null,
    resetPasswordExpires: null,
    tokenVersion: 0,
    emailVerified: false,
    emailVerificationToken: null,
    emailVerificationSentAt: null,
    emailVerificationExpires: null,
    emailVerifiedAt: null,
    emailVerificationUsed: null,

    pendingEmail: null,
    pendingEmailToken: null,
    pendingEmailSentAt: null,
    pendingEmailExpires: null,
    pendingEmailUsed: null,
    regInvites: [],
    referredByUserId,
    numReferralsAvailable,
    stripeCustomerId: null,
    organizationId: null,
    googleDrive: null,
    photoUrl: null,
    lastCreditsPurchasedAt: null,
    showCreditsUsed: true,
    preferredVoice: null,
    preferredReasoningEffort: 'auto',

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  let user: Awaited<ReturnType<typeof db.users.create>>;
  try {
    user = await db.users.create(buildUser);
  } catch (err: unknown) {
    // E11000: concurrent registration race on the unique email index.
    if ((err as { code?: number }).code === 11000) {
      throw new BadRequestError('Email already in use');
    }
    throw err;
  }
  // Update the invite to mark it as used (only when registration used an invite code)
  if (invite) {
    const usageEventDate = new Date();
    const usageEntry = { userId: user.id, usedAt: usageEventDate };
    invite.usageHistory = [...(invite.usageHistory ?? []), usageEntry];

    if (isUnlimitedInvite) {
      delete invite.used;
      delete invite.usedbyId;
      invite.status = RegInviteStatusType.open;
    } else {
      invite.used = usageEventDate;
      invite.usedbyId = user.id;
      invite.status = RegInviteStatusType.used;
    }
    await db.registrationInvites.update(
      isUnlimitedInvite
        ? { id: invite.id, usageHistory: invite.usageHistory, status: invite.status }
        : {
            id: invite.id,
            usageHistory: invite.usageHistory,
            used: invite.used,
            usedbyId: invite.usedbyId,
            status: invite.status,
          },
      isUnlimitedInvite ? { unset: ['used', 'usedbyId'] } : undefined
    );
  }

  return user;
};

/**
 * Registers a new user via the OTC (one-time code) flow and finalizes the
 * email-verified state + deferred free-credit grant in one place.
 *
 * OTC already proves email ownership, so the free credits that `registerUser`
 * defers behind PENDING_FREE_CREDITS_TAG can be granted immediately. Ordering
 * matters: the grant happens BEFORE the pending tag is dropped, so if the grant
 * throws, the tag stays on the account (a retry breadcrumb - the grant is keyed
 * by an idempotent transactionId) rather than leaving the user verified with the
 * tag gone and no credits. The registration gate (invite-only vs. open) is left
 * exactly as `registerUser` enforces it - this wrapper does not skip it.
 */
export const registerViaOTC = async (
  params: RegisterUserParameters,
  adapters: RegisterUserAdapters
): Promise<IUserDocument> => {
  const { db, logger } = adapters;
  const newUser = await registerUser(params, adapters);

  if (newUser.signupGrant) {
    await db.users.update({ id: newUser.id, emailVerified: true, emailVerifiedAt: new Date() });
  }

  const taggedUser = { ...newUser, tags: [...new Set([...(newUser.tags ?? []), 'Customer'])] };

  let finalTags = taggedUser.tags;
  let pendingCreditGrant = newUser.pendingCreditGrant ?? null;

  if (db.creditTransactions) {
    const release = await releasePendingFreeCredits(taggedUser, {
      db: {
        adminSettings: db.adminSettings,
        creditTransactions: db.creditTransactions,
        creditLots: db.creditLots,
        users: db.users,
        signupProtection: db.signupProtection,
      },
      reason: 'OTC registration (email verified)',
      logger,
      collectRiskSignals: adapters.collectRiskSignals,
    });
    // On failure the patch is empty, so the pending tag and amount survive as the retry
    // breadcrumb while the user is still verified and let in.
    if (release.released) {
      finalTags = release.patch.tags ?? finalTags;
      pendingCreditGrant = null;
      if (release.currentCredits !== null) newUser.currentCredits = release.currentCredits;
    }
  } else {
    finalTags = finalTags.filter(t => t !== PENDING_FREE_CREDITS_TAG);
    pendingCreditGrant = null;
  }

  const verification = {
    emailVerified: true,
    emailVerifiedAt: new Date(),
    tags: finalTags,
    pendingCreditGrant,
  };
  // currentCredits is deliberately not written: addCredits already `$inc`ed it.
  await db.users.update({ id: newUser.id, ...verification });

  if (newUser.signupGrant) {
    const persisted = await db.users.findById(newUser.id);
    if (persisted) return persisted;
  }
  return { ...newUser, ...verification } as IUserDocument;
};

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, await bcrypt.genSalt(10));
}
