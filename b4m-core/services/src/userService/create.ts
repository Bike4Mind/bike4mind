import { IUser, IUserRepository, UserLevelType } from '@bike4mind/common';
import bcrypt from 'bcryptjs';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, await bcrypt.genSalt(10));
}

// Creates a user with the given username and email, and any of the
// other properties in the given record.  If a password is provided,
// it should be plaintext; it will be hashed and stored.
export async function createUser(
  params: {
    username: string;
    email: string;
    name?: string;
    record?: Partial<IUser>;
    tags?: Array<string>;
    level?: UserLevelType;
    isAdmin?: boolean;
    initialCredits?: number;
    emailVerified?: boolean;
  },
  adapters: {
    db: {
      users: Pick<IUserRepository, 'create' | 'findByUsernameOrEmail'>;
    };
  }
): Promise<IUser> {
  const { username, name, email, record, tags, level, isAdmin, initialCredits, emailVerified } = params;
  const { db } = adapters;

  // Pass raw username/email - `findByUsernameOrEmail` owns the exact-match
  // escaping + anchoring. Pre-escaping here would be double-escaped by that
  // layer, so the username dup-check would never match an existing user.
  const existing = await db.users.findByUsernameOrEmail(username, email);

  if (existing) {
    const type = existing.email === email ? 'Email' : 'Username';
    throw new Error(`${type} already in use`);
  }

  const plaintextPassword = record?.password ?? null;
  const password = plaintextPassword && (await hashPassword(plaintextPassword));

  const userRecord: Omit<IUser, 'id'> = {
    name: name ?? username,
    groups: [],
    mementos: [],
    ...record,
    isAdmin: isAdmin ?? false,
    storageLimit: 1000,
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
    email,
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
    showCreditsUsed: false,
    preferredVoice: null,
    preferredReasoningEffort: 'auto',
    lastCreditsPurchasedAt: null,
  };

  const records = await db.users.create(userRecord);

  return records;
}
