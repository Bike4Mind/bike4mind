import {
  isReservedUsername,
  resolveUserStorageLimit,
  IUser,
  IUserRepository,
  RESERVED_USERNAME_MESSAGE,
  UserLevelType,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import bcrypt from 'bcryptjs';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, await bcrypt.genSalt(10));
}

// Creates a user with the given username and email, and any of the
// other properties in the given record.  If a password is provided,
// it should be plaintext; it will be hashed and stored.
//
// `email` may be omitted to create an emailless account - the same shape an OAuth
// signup with no provider-verified email produces (see verifyCallback's create path).
// Such an account cannot receive a login one-time code until it adds an address.
//
// A reserved username (isReservedUsername) is refused unless the caller passes
// `allowReservedUsername: true`, which only admin-gated and test-only paths do - never from request input.
export async function createUser(
  params: {
    username: string;
    email?: string | null;
    name?: string;
    record?: Partial<IUser>;
    tags?: Array<string>;
    level?: UserLevelType;
    isAdmin?: boolean;
    initialCredits?: number;
    emailVerified?: boolean;
    allowReservedUsername?: boolean;
  },
  adapters: {
    db: {
      users: Pick<IUserRepository, 'create' | 'findByUsernameOrEmail'>;
    };
  }
): Promise<IUser> {
  const { username, name, email, record, tags, level, isAdmin, initialCredits, emailVerified, allowReservedUsername } =
    params;
  const { db } = adapters;

  if (!allowReservedUsername && isReservedUsername(username)) {
    throw new BadRequestError(RESERVED_USERNAME_MESSAGE);
  }

  // Pass raw username/email - `findByUsernameOrEmail` owns the exact-match
  // escaping + anchoring. Pre-escaping here would be double-escaped by that
  // layer, so the username dup-check would never match an existing user.
  const existing = await db.users.findByUsernameOrEmail(username, email);

  if (existing) {
    const type = email && existing.email === email ? 'Email' : 'Username';
    throw new Error(`${type} already in use`);
  }

  const plaintextPassword = record?.password ?? null;
  const password = plaintextPassword && (await hashPassword(plaintextPassword));

  const storage = resolveUserStorageLimit(record ?? {});
  const userRecord: Omit<IUser, 'id'> = {
    name: name ?? username,
    groups: [],
    mementos: [],
    ...record,
    isAdmin: isAdmin ?? false,
    storageLimit: storage.limitMb,
    storageLimitOverride: record?.storageLimitOverride ?? (storage.source === 'override' ? storage.limitMb : null),
    planStorageLimit: record?.planStorageLimit ?? null,
    currentStorageSize: 0,
    currentCredits: initialCredits ?? 0,
    level: level ? level : 'DemoUser',
    isBanned: false,
    isModerated: false,
    subscribedUntil: null,
    oauthCredentials: record?.oauthCredentials ?? null,
    authProviders: [],
    atlassianConnect: null,
    notionConnect: null,
    password,
    // Caller must pass explicit intent - `password` truthiness is NOT a safe signal
    // (some callers store an auto-generated, unusable password to satisfy this
    // record shape). Passwordless-first: defaults to false.
    hasUsablePassword: record?.hasUsablePassword ?? false,
    username,
    email: email ?? null,
    // Normalize to [] (never null): a null tags list makes tag-gated UI (e.g.
    // useAccessibleModels) unable to distinguish "no tags" from "not loaded".
    tags: tags ?? [],
    systemFiles: [],
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
    loginRecords: [],
    resetPasswordToken: null,
    resetPasswordSentAt: null,
    resetPasswordExpires: null,
    tokenVersion: 0,
    forcePasswordChangeRequired: record?.forcePasswordChangeRequired ?? false,
    emailVerified: !!emailVerified,
    emailVerificationToken: null,
    emailVerificationSentAt: null,
    emailVerificationExpires: null,
    emailVerifiedAt: typeof emailVerified === 'boolean' && !!emailVerified ? new Date() : null,
    emailVerificationUsed: null,

    pendingEmail: null,
    pendingEmailToken: null,
    pendingEmailSentAt: null,
    pendingEmailExpires: null,
    pendingEmailUsed: null,
    regInvites: [],
    numReferralsAvailable: 3,
    stripeCustomerId: record?.stripeCustomerId ?? null,
    organizationId: record?.organizationId ?? null,
    googleDrive: null,
    photoUrl: record?.photoUrl ?? null,
    showCreditsUsed: true,
    preferredVoice: null,
    preferredReasoningEffort: 'auto',
    lastCreditsPurchasedAt: null,
  };

  const records = await db.users.create(userRecord);

  return records;
}
