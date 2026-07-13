import {
  CreditHolderType,
  IAdminSettingsRepository,
  ICreditTransactionRepository,
  IUserDocument,
  IUserRepository,
} from '@bike4mind/common';
import { IRegistrationInvite, RegInviteStatusType } from '@bike4mind/common';
import { ISubscriberRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { CURRENT_POLICY_VERSION, PENDING_FREE_CREDITS_TAG, settingsMap } from '@bike4mind/common';
import { addCredits } from '../creditService';
import { isDisposableEmail } from './disposableEmail';

// NOT parsed at runtime - derives the param type via z.infer only. The policy/age fields are
// enforced by the manual `!== true` / version checks in registerUser below, not by this schema.
// Adding a field here does NOT enforce it until you validate it at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used only as type via z.infer
const registerUserSchema = z.object({
  username: z.string(),
  email: z.string(),
  name: z.string(),
  inviteCode: z.string().optional(),
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
      ip: z.string().optional().prefault(''),
      location: z.string().optional(),
    })
    .optional(),
});

export type RegisterUserParameters = z.infer<typeof registerUserSchema>;

interface RegisterUserAdapters {
  db: {
    users: IUserRepository;
    adminSettings: IAdminSettingsRepository;
    registrationInvites: {
      findByCode: (code: string) => Promise<IRegistrationInvite | null>;
      update: (invite: IRegistrationInvite) => Promise<unknown>;
    };
    subscribers?: ISubscriberRepository;

    /**
     * creditTransactions are required if you need credits to be added
     * to the user
     */
    creditTransactions?: ICreditTransactionRepository;
  };
  logger: Logger;
  /**
   * When true, skip the invite-code / open-registration check.
   * Used by OTC registration where email ownership is already verified.
   */
  skipInviteCheck?: boolean;
}

export const registerUser = async (
  params: RegisterUserParameters,
  { db, logger, skipInviteCheck }: RegisterUserAdapters
) => {
  const { username, email, name, inviteCode, password, metadata, acceptedPolicyVersion, ageAttestation } = params;

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

  // shape-check the email before any DB work. Ownership is proven by OTC, so
  // this only rejects junk input - same light regex as /api/otc/send. Normalization is
  // for the checks below only; the stored email keeps the caller's casing.
  const normalizedEmail = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new BadRequestError('Invalid email address');
  }

  const existingUser = await db.users.findByUsernameOrEmail(username, email);
  if (existingUser) {
    const field = existingUser.username === username ? 'username' : 'email';
    throw new BadRequestError(`This ${field} is already registered`);
  }

  // anti-sybil: refuse throwaway inboxes at the chokepoint every credit-bearing
  // registration flows through. (OAuth/Okta signup and admin user creation build accounts
  // elsewhere, but none of those paths grant farmable credits.) Registration-only - OTC
  // sign-in for existing accounts never reaches this function, so grandfathered users on
  // such domains are unaffected.
  const blockDisposableSetting = await db.adminSettings.findBySettingName('blockDisposableEmails');
  const blockDisposableParsed = settingsMap.blockDisposableEmails.schema.safeParse(
    blockDisposableSetting?.settingValue
  );
  const blockDisposable = blockDisposableParsed.success ? blockDisposableParsed.data : true;
  if (blockDisposable && isDisposableEmail(normalizedEmail)) {
    throw new BadRequestError('Disposable email addresses are not allowed');
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
  //     ownership is proven (immediately by registerViaOTC - the OTC already proved the
  //     inbox - or by /api/email/verify for legacy flows).
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

  let invite: IRegistrationInvite | null = null;
  let isUnlimitedInvite = false;
  let freeCredits = 0;
  let effectiveStorage = 1000;

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
    let subscriberStorage = 1000; // Default storage
    let subscriberStorageFound = false;

    if (invite.email && db.subscribers) {
      try {
        const subscriber = await db.subscribers.findByEmail(invite.email);
        if (subscriber && subscriber.inviteCode === normalizedInviteCode) {
          // Use subscriber-specific allocations if available
          subscriberCredits = subscriber.startingCredits || 0;
          subscriberStorage = subscriber.startingStorage || 1000;
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
    effectiveStorage = subscriberStorageFound ? subscriberStorage : inviteStorage > 0 ? inviteStorage : 1000;
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
    effectiveStorage = 1000;
    logger.info(`Open registration (no invite) for ${email}: free credits deferred until email verification`);
  }

  // invite-resolved credits are deferred behind the same pending tag as the
  // open-registration grant; the amount travels on the user doc.
  if (freeCredits > 0) {
    tags = [...new Set([...tags, PENDING_FREE_CREDITS_TAG])];
  }

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
    storageLimit: effectiveStorage, // Priority: subscriber > invite code > default (1000)
    currentStorageSize: 0,
    currentCredits: 0,
    pendingCreditGrant: freeCredits > 0 ? freeCredits : null,
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
    numReferralsAvailable: 3,
    stripeCustomerId: null,
    organizationId: null,
    googleDrive: null,
    photoUrl: null,
    lastCreditsPurchasedAt: null,
    showCreditsUsed: false,
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
    await db.registrationInvites.update(invite);
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

  let finalTags = [...new Set([...(newUser.tags ?? []), 'Customer'])];
  const hasPendingCredits = newUser.tags?.includes(PENDING_FREE_CREDITS_TAG);

  if (hasPendingCredits && db.creditTransactions) {
    try {
      // an invite-resolved amount travels on the user doc and wins; the
      // defaultFreeCredits setting is the open-registration fallback.
      let amount = newUser.pendingCreditGrant ?? null;
      if (amount === null) {
        const setting = await db.adminSettings.findBySettingName('defaultFreeCredits');
        const parsed = settingsMap.defaultFreeCredits.schema.safeParse(setting?.settingValue);
        amount = parsed.success ? parsed.data : 0;
      }
      if (amount > 0) {
        const updatedHolder = await addCredits(
          {
            ownerId: newUser.id,
            ownerType: CreditHolderType.User,
            credits: amount,
            type: 'generic_add',
            transactionId: `otc-register-grant:${newUser.id}`,
            reason: 'OTC registration (email verified)',
          },
          { db: { creditTransactions: db.creditTransactions }, creditHolderMethods: db.users }
        );
        newUser.currentCredits = updatedHolder.currentCredits;
      }
      // Grant succeeded (or nothing to grant) - safe to drop the pending tag.
      finalTags = finalTags.filter(t => t !== PENDING_FREE_CREDITS_TAG);
    } catch (grantError) {
      // Keep PENDING_FREE_CREDITS_TAG so the grant can be retried; still verify
      // and let the user in (they've proven email ownership).
      logger.error(`OTC registration credit grant failed for user ${newUser.id}`, grantError);
    }
  } else {
    finalTags = finalTags.filter(t => t !== PENDING_FREE_CREDITS_TAG);
  }

  const verifiedUser = {
    ...newUser,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    tags: finalTags,
    // The pending amount is cleared exactly when the pending tag is dropped (grant
    // settled or nothing to grant); on grant failure both survive as the retry breadcrumb.
    pendingCreditGrant: finalTags.includes(PENDING_FREE_CREDITS_TAG) ? (newUser.pendingCreditGrant ?? null) : null,
  } as IUserDocument;
  await db.users.update(verifiedUser);

  return verifiedUser;
};

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, await bcrypt.genSalt(10));
}
