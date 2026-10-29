import { VERIFIED_SLACK_IDENTITY_FILTER, canonicalizeEmail } from '@bike4mind/common';
import {
  ADMIN_PERMISSIONS,
  AuthStrategy,
  PENDING_FREE_CREDITS_TAG,
  CollectionType,
  IAuthProviders,
  ISecurityQuestion,
  IUserDocument,
  IUserRepository,
  IUserNote,
  IModerationHit,
  ISignupRiskScore,
  SIGNUP_RISK_REVIEW_STATES,
  SIGNUP_RISK_SIGNALS,
  UserModerationStatus,
  MFA_MAX_FAILED_ATTEMPTS,
  MFA_LOCKOUT_DURATION_MS,
  MFA_ATTEMPT_RESET_WINDOW_MS,
  SIGNUP_GRANT_UNLOCK_REASONS,
} from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import mongoose, { Document, Model, model, Schema, Query, type PipelineStage } from 'mongoose';
import { NotFoundError } from '@bike4mind/utils';
import { decryptAtRest, encryptAtRest, isEncrypted } from '@bike4mind/utils/security';
import { convertIds } from '../../utils/mongo';
import { CountersSchema } from '../infra/ops/CounterModel';
import BaseRepository from '@bike4mind/db-core';
import { executeFacetCompatible } from '../../utils/documentdb-compat';
import { buildCollectionSearchPipeline } from '../../queries/collectionSearchQuery';
import { NETWORK_META_FIELDS } from './networkMetaFields';

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export interface IUserObject extends IUserDocument, Omit<Document, 'id'> {}

export interface IUserModel extends Model<IUserDocument> {}

const LoginRecordSchema = new Schema(
  {
    loginTime: { type: Date, required: true },
    logoutTime: { type: Date },
    userAgent: { type: String, required: true },
    browser: { type: String, required: true },
    operatingSystem: { type: String, required: true },
    deviceType: { type: String, required: true },
    screenResolution: { type: String, required: true },
    viewportSize: { type: String, required: true },
    colorDepth: { type: Number, required: true },
    pixelDepth: { type: Number, required: true },
    devicePixelRatio: { type: Number, required: true },
    ip: { type: String },
    location: { type: String },
    networkType: { type: String },
  },
  { _id: false }
);

const SecurityQuestionSchema = new Schema<ISecurityQuestion>(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
  },
  { _id: false }
);

const UserNoteSchema = new Schema<IUserNote>(
  {
    timestamp: { type: String, required: false },
    note: { type: String, required: false },
    userName: { type: String, required: false },
  },
  { _id: false }
);

const MFASchema = new Schema(
  {
    // TOTP secret (encrypted at rest, see encryptTotpSecretInUpdate) + hashed backup codes -
    // never serialize to a client. select:false keeps them out of every default
    // query/response; the MFA subsystem loads them explicitly via findByIdWithMfaSecrets
    // (+select), which decrypts the secret. `totpEnabled` (not select:false) is the flag
    // callers use to detect that MFA is configured.
    totpSecret: { type: String, required: true, select: false },
    totpEnabled: { type: Boolean, default: false },
    backupCodes: { type: [String], default: [], select: false },
    // Encrypted like totpSecret; only present between setup and enable.
    pendingBackupCodes: { type: String, select: false },
    setupAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    // Server-side attempt tracking (can't be bypassed by refresh/cancel)
    failedAttempts: { type: Number, default: 0 },
    lastFailedAttempt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
  },
  { _id: false }
);

// Typed sub-schema for linked SSO identities. Validation only bites on
// create/save paths - the OAuth link/refresh writes go through User.updateOne
// (see oauthAccountLink.ts applyAccountLink), which bypasses document
// validators - so legacy rows (id:null, missing tokens) keep loading fine.
// `id: false` suppresses the subdocument `id` virtual, which would otherwise
// conflict with the real provider-subject `id` path.
const AuthProviderSchema = new Schema<IAuthProviders>(
  {
    strategy: { type: String, required: true, enum: Object.values(AuthStrategy) },
    id: { type: String, default: null },
    accessToken: { type: String },
    refreshToken: { type: String },
    // SAML-specific metadata
    samlNameId: { type: String },
    samlSessionIndex: { type: String },
    samlIdentityProviderId: { type: String },
    // Okta-specific metadata
    oktaIdentityProviderId: { type: String },
    // Whether accessToken/refreshToken are encrypted with SECRET_ENCRYPTION_KEY
    encrypted: { type: Boolean },
  },
  { _id: false, id: false }
);

const SystemFileEntrySchema = new Schema(
  {
    fileId: { type: String, required: true },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const UserPreferencesSchema = new Schema(
  {
    language: { type: String },
    favoriteTags: { type: [String] },
    favoriteModelIds: { type: [String], default: [] },
    hiddenSurfaces: { type: [String], default: [] },
    fileBrowserViewMode: { type: String, enum: ['home', 'list', 'grid', 'tags'] },
    optiSessionId: { type: String, default: null },
    lastUsedTextModel: { type: String, default: null },
    lastUsedImageModel: { type: String, default: null },
    lastUsedImageEditModel: { type: String, default: null },
    showDebug: { type: Boolean },
    showHelp: { type: Boolean },
    maxVisibleLines: { type: Number },
    autoCollapseContent: { type: Boolean },
    enableAutoScroll: { type: Boolean },
    scrollbarWidth: { type: Number },
    experimentalFeatures: { type: Map, of: Boolean },
    contextTelemetryLevel: { type: String, enum: ['none', 'basic', 'enhanced'] },
    contextTelemetryConsentedAt: { type: Date },
    rechartsDisplayMode: { type: String, enum: ['inline', 'artifact'] },
    toolsCatalogCollapsed: { type: Boolean },
    docxTemplateFileId: { type: String, default: null },
    // Layer-2 Agent-mode preference. Drives the M4 classifier wire-up;
    // without persistence, the Smart Routing tri-state in
    // ExperimentalFeatureToggle silently reverts to 'off' on reload.
    agentModeDefault: { type: String, enum: ['off', 'auto', 'on'] },
    showFunTools: { type: Boolean },
    showSplashCards: { type: Boolean },
    desktopPromoDismissed: { type: Boolean },
  },
  { _id: false }
);

const NotionConnectSchema = new Schema(
  {
    accessToken: { type: String, required: true, select: false },
    workspaceId: { type: String, required: true },
    workspaceName: { type: String, required: true },
    workspaceIcon: { type: String, required: false },
    botId: { type: String, required: true },
    owner: {
      type: {
        type: String,
        enum: ['user', 'workspace'],
        required: false,
      },
      user: {
        id: { type: String, required: false },
        name: { type: String, required: false },
        avatarUrl: { type: String, required: false },
        email: { type: String, required: false },
      },
    },
    connectedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['connected', 'needs_reconnect'],
      default: 'connected',
    },
    disconnectReason: { type: String, required: false },
    writeEnabled: { type: Boolean, default: false },
    rootPageId: { type: String, required: false },
    /** 'all' = full workspace access (legacy default), 'selected' = curated page list */
    accessMode: {
      type: String,
      enum: ['all', 'selected'],
      default: 'all',
    },
    /** Pages explicitly granted access. Children inherit unless excluded. */
    allowedPages: {
      type: [
        {
          id: { type: String, required: true },
          title: { type: String, required: true },
          type: { type: String, enum: ['page', 'database'], required: true },
          access: { type: String, enum: ['read', 'readwrite'], default: 'read' },
        },
      ],
      default: [],
    },
    /** Child page IDs explicitly excluded from inherited parent access */
    excludedPageIds: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const KeywordRoutingRuleSchema = new Schema(
  {
    keywords: { type: [String], required: true },
    notebookId: { type: String, required: true },
  },
  { _id: false }
);

/** Newest-first cap on the retained per-user moderation-hit log. */
export const MODERATION_HITS_RETAINED = 50;

const ModerationHitSchema = new Schema(
  {
    at: { type: Date, required: true },
    categories: { type: [String], default: [] },
    source: { type: String, enum: ['openai', 'bedrock', 'provider'], required: true },
    questId: { type: String, required: false },
  },
  { _id: false }
);

const UserModerationSchema = new Schema(
  {
    hitCount: { type: Number, default: 0 },
    lastHitAt: { type: Date, default: null },
    hits: { type: [ModerationHitSchema], default: [] },
    status: {
      type: String,
      enum: ['active', 'throttled', 'suspend_pending', 'suspended'],
      default: 'active',
    },
    statusChangedAt: { type: Date, default: null },
    throttledUntil: { type: Date, default: null },
    appealedAt: { type: Date, default: null },
    appealText: { type: String, default: null },
  },
  { _id: false }
);

export class UserRepository extends BaseRepository<IUserDocument> implements IUserRepository {
  constructor(model: IUserModel) {
    super(model);
  }

  /** Remove the given group ids from EVERY user that has them (group-type revoke/delete). */
  async removeGroupsFromAllUsers(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    await this.model.updateMany({ groups: { $in: groupIds } }, { $pull: { groups: { $in: groupIds } } });
  }

  /** Null the active-org pointer of every user on the org (org delete). */
  async clearOrganizationPointer(organizationId: string): Promise<void> {
    await this.model.updateMany({ organizationId }, { $set: { organizationId: null } });
  }

  /** Add one group id to one user (idempotent via $addToSet). */
  async addGroupToUser(userId: string, groupId: string): Promise<void> {
    await this.model.updateOne({ _id: userId }, { $addToSet: { groups: groupId } });
  }

  /** Merge tags into one user's tags (idempotent via $addToSet). No-op on an empty list. */
  async addTagsToUser(userId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    // Legacy accounts can store null; $addToSet requires an array. The guard preserves concurrent tag additions.
    await this.model.updateOne({ _id: userId, tags: null }, { $set: { tags: [] } });
    await this.model.updateOne({ _id: userId }, { $addToSet: { tags: { $each: tags } } });
  }

  async clearPendingFreeCreditGrant(userId: string): Promise<IUserDocument | null> {
    await this.model.updateOne({ _id: userId, tags: null }, { $set: { tags: [] } });
    const user = await this.model.findOneAndUpdate(
      { _id: userId },
      { $pull: { tags: PENDING_FREE_CREDITS_TAG }, $set: { pendingCreditGrant: null } },
      { new: true }
    );
    return user?.toJSON() ?? null;
  }

  async pullSystemFilesForUsers(userIds: string[], fileIds: string[]): Promise<void> {
    const ids = userIds.filter(id => mongoose.isObjectIdOrHexString(id));
    if (ids.length === 0 || fileIds.length === 0) return;
    await this.model.updateMany(
      { _id: { $in: ids }, 'systemFiles.fileId': { $in: fileIds } },
      { $pull: { systemFiles: { fileId: { $in: fileIds } } } }
    );
  }

  /** Remove one group id from one user. */
  async removeGroupFromUser(userId: string, groupId: string): Promise<void> {
    await this.model.updateOne({ _id: userId }, { $pull: { groups: groupId } });
  }

  /** Remove several group ids from one user (idempotent $pull). No-op on an empty list. */
  async removeGroupsFromUser(userId: string, groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    await this.model.updateOne({ _id: userId }, { $pull: { groups: { $in: groupIds } } });
  }

  /** Member ids per group id in one aggregation (keyed by group id; absent = no members). */
  async findUserIdsByGroupIds(groupIds: string[]): Promise<Record<string, string[]>> {
    if (groupIds.length === 0) return {};
    // $addToSet, not $push: a user whose user.groups array holds a duplicate entry for the same
    // group (e.g. a pre-#1224 double-accept via the legacy group-invite path) would otherwise be
    // counted twice for that group. $addToSet makes memberCount correct by construction rather
    // than relying on every writer to dedupe user.groups itself.
    const rows = await this.model.aggregate<{ _id: string; userIds: string[] }>([
      { $match: { groups: { $in: groupIds } } },
      { $unwind: '$groups' },
      { $match: { groups: { $in: groupIds } } },
      { $group: { _id: '$groups', userIds: { $addToSet: { $toString: '$_id' } } } },
    ]);
    const membersByGroup: Record<string, string[]> = {};
    for (const row of rows) membersByGroup[row._id] = row.userIds;
    return membersByGroup;
  }

  async findAllByEmailsOrUsernames(emails: string[], usernames: string[]) {
    // Case-insensitive to match findByUsernameOrEmail below -- email/username are stored
    // verbatim (no lowercase transform), so a caller-typed case variant must still resolve.
    // Caveat for callers: uniqueness on this schema is case-SENSITIVE (username_1, email_1),
    // so two distinct real accounts differing only by case can both match one input string.
    // A caller that grants access based on a result here (sharingService/create.ts is the one
    // that does) must treat more than one match per input as ambiguous, not pick one silently.
    const result = await this.model
      .find({
        $or: [{ email: { $in: emails } }, { username: { $in: usernames } }],
      })
      .collation({ locale: 'en', strength: 2 });
    return result.map(d => d.toJSON());
  }

  async findByUsernameOrEmail(username: string, email?: string | null) {
    const escapedUsername = escapeRegExp(username);
    // Emailless accounts exist (OAuth signup with no provider-verified email), so a caller
    // with only a username must not turn this clause into `{ email: null }` - that would
    // match every account that has no email.
    const identity: Array<Record<string, unknown>> = [{ username: { $regex: `^${escapedUsername}$`, $options: 'i' } }];
    if (email) {
      identity.push({ email });
    }
    const query = { $or: identity };

    const result = await this.model.findOne(query).collation({ locale: 'en', strength: 2 }).select('+password');

    return result?.toJSON() ?? null;
  }

  async findByEmail(email: string) {
    return this.model.findOne({ email }).collation({ locale: 'en', strength: 2 });
  }

  async existsOtherUserWithEmail(email: string, excludeUserId?: string): Promise<boolean> {
    return this.existsOtherUserWithValue('email', email, excludeUserId);
  }

  async existsOtherUserWithUsername(username: string, excludeUserId?: string): Promise<boolean> {
    return this.existsOtherUserWithValue('username', username, excludeUserId);
  }

  // A regex rather than .collation() for DocumentDB portability (see existsOtherUserWithValue).
  // A null emailVerifiedAt is a legacy verified row from before the field was written.
  async existsVerifiedUserOnEmailDomain(domain: string, verifiedBefore: Date): Promise<boolean> {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) return false;
    const filter = {
      email: { $regex: `[@.]${escapeRegExp(normalized)}\\s*$`, $options: 'i' },
      emailVerified: true,
      $or: [{ emailVerifiedAt: { $lte: verifiedBefore } }, { emailVerifiedAt: null }],
      isBanned: { $ne: true },
      isSystem: { $ne: true },
      deletedAt: { $exists: false },
    };
    return (await this.model.exists(filter)) !== null;
  }

  // An anchored case-insensitive regex instead of .collation(): DocumentDB has no collation
  // support (see documentdb-compat.ts), so this is the one form that matches the same rows on
  // both engines. The \s* anchors also match legacy rows stored with surrounding whitespace. Soft-deleted rows count, because the unique index still covers them.
  private async existsOtherUserWithValue(
    field: 'email' | 'username',
    value: string,
    excludeUserId: string | undefined
  ): Promise<boolean> {
    const normalized = value.normalize('NFC').trim();
    if (!normalized) return false;
    const filter: Record<string, unknown> = {
      [field]: { $regex: `^\\s*${escapeRegExp(normalized)}\\s*$`, $options: 'i' },
    };
    if (excludeUserId) filter._id = { $ne: excludeUserId };
    return (await this.model.exists(filter)) !== null;
  }

  async findOrCreateByEmail(email: string, defaults: Partial<IUserDocument>): Promise<IUserDocument> {
    try {
      const doc = await this.model.findOneAndUpdate(
        { email },
        { $setOnInsert: { ...defaults, email } },
        { upsert: true, new: true }
      );
      return doc!;
    } catch (err: unknown) {
      // E11000: concurrent upsert race - the other request won, fetch the existing row
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
        const existing = await this.model.findOne({ email });
        if (existing) return existing;
      }
      throw err;
    }
  }

  async findByEmailVerificationToken(token: string) {
    return this.model.findOne({ emailVerificationToken: token });
  }

  async findByPendingEmailToken(token: string) {
    return this.model.findOne({ pendingEmailToken: token });
  }

  async findByIdWithPassword(id: string): Promise<IUserDocument | null> {
    const result = await this.model.findOne({ _id: id }).select('+password');
    return result ? result.toJSON() : null;
  }

  async findByIdWithNotionToken(id: string): Promise<IUserDocument | null> {
    const result = await this.model.findOne({ _id: id }).select('+notionConnect.accessToken');
    return result ? result.toJSON() : null;
  }

  /**
   * Loads a user WITH the select:false MFA secrets - for server-side MFA verification only.
   * `mfa.totpSecret` and `mfa.pendingBackupCodes` come back decrypted; writing the snapshot back
   * re-encrypts them (see encryptTotpSecretInUpdate), so snapshot writers never persist the plaintext.
   */
  async findByIdWithMfaSecrets(id: string): Promise<IUserDocument | null> {
    const result = await this.model
      .findOne({ _id: id })
      .select('+mfa.totpSecret +mfa.backupCodes +mfa.pendingBackupCodes');
    if (!result) return null;
    const user: IUserDocument = result.toJSON();
    if (user.mfa?.totpSecret) {
      user.mfa.totpSecret = decryptAtRest(user.mfa.totpSecret);
    }
    if (user.mfa?.pendingBackupCodes) {
      user.mfa.pendingBackupCodes = decryptAtRest(user.mfa.pendingBackupCodes);
    }
    return user;
  }

  /**
   * Atomically increment the MFA failed-attempt counter and conditionally set the lockout.
   * Uses a two-stage MongoDB aggregation pipeline update so the increment and lockout write
   * are a single atomic operation - a read-modify-write would allow concurrent requests to
   * each read the same count and undercount failures, defeating the 3-strike lockout.
   */
  async atomicRecordMfaFailedAttempt(userId: string): Promise<IUserDocument | null> {
    const now = new Date();
    const result = await this.model.findOneAndUpdate({ _id: userId }, mfaAttemptPipeline(now), { new: true });
    return result ? result.toJSON() : null;
  }

  /**
   * Book an MFA attempt BEFORE the code is compared, refusing while the user is locked out.
   * Counting only after a failed compare lets a burst of concurrent guesses all pass the lockout
   * check first; reserving up front caps the codes compared per window at MFA_MAX_FAILED_ATTEMPTS.
   * A successful verify clears the counter in its own write.
   */
  async atomicReserveMfaAttempt(userId: string): Promise<{ reserved: boolean; user: IUserDocument | null }> {
    const now = new Date();
    const result = await this.model.findOneAndUpdate(
      { _id: userId, $or: [{ 'mfa.lockedUntil': null }, { 'mfa.lockedUntil': { $lte: now } }] },
      mfaAttemptPipeline(now),
      { new: true }
    );
    if (result) return { reserved: true, user: result.toJSON() };
    // Locked (or gone): report the current lockout state without counting another attempt.
    const current = await this.model.findOne({ _id: userId });
    return { reserved: false, user: current ? current.toJSON() : null };
  }

  /**
   * Record `step` as the last accepted TOTP time step, only if it is newer than the stored one.
   * Returns false when the step was already used, so a code cannot be replayed within its window.
   */
  async atomicClaimTotpStep(userId: string, step: number): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: userId, $or: [{ totpLastStep: null }, { totpLastStep: { $lt: step } }] },
      { $set: { totpLastStep: step } }
    );
    return result.modifiedCount === 1;
  }

  /**
   * Claim the one free-credit grant allowed per inbox (canonicalizeEmail of the account's email).
   * True when this account holds the claim, including from an earlier attempt, so a retried grant
   * stays idempotent; false when another account already holds it. The unique
   * freeCreditClaimEmail_1 index makes the claim atomic across concurrent signups; the pre-check
   * covers a deployment whose index has not been built yet. An account without a usable email has
   * nothing to dedupe on and is allowed.
   */
  async claimFreeCreditGrant(userId: string): Promise<boolean> {
    const user = await this.model.findById(userId, { email: 1, freeCreditClaimEmail: 1 }).lean();
    if (!user) return false;
    if (user.freeCreditClaimEmail) return true;
    const claimEmail = user.email ? canonicalizeEmail(user.email) : null;
    if (!claimEmail) return true;

    if (await this.model.exists({ freeCreditClaimEmail: claimEmail, _id: { $ne: userId } })) return false;
    try {
      const result = await this.model.updateOne(
        { _id: userId, freeCreditClaimEmail: null },
        { $set: { freeCreditClaimEmail: claimEmail } }
      );
      // A zero-match update means a concurrent call for this same account claimed first.
      return result.modifiedCount === 1 || result.matchedCount === 0;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  /**
   * Remove `codeHash` from the stored backup codes, only if it is still present. Returns true
   * exactly once per code, so a backup code cannot be consumed by two requests at once. A
   * whole-document write from a pre-read snapshot would instead restore a code another request
   * had already spent, so consumption must be this targeted `$pull`.
   */
  async atomicConsumeBackupCode(userId: string, codeHash: string): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: userId, 'mfa.backupCodes': codeHash },
      { $pull: { 'mfa.backupCodes': codeHash } }
    );
    return result.modifiedCount === 1;
  }

  /**
   * Enable MFA only if the stored secret is still the one just verified (`totpSecret`) and MFA is
   * still disabled. Two concurrent enrollments can otherwise interleave so that a code checked
   * against the first secret enables the second: the authenticator holds one secret and the user
   * is locked out. Matching on the verified secret makes the write refuse instead.
   *
   * The stored secret is random-IV ciphertext, so `totpSecret` (plaintext) can never match it in a
   * filter. Decrypt-compare first, then condition the write on the exact stored value: a concurrent
   * re-setup writes fresh ciphertext, so the compare-and-set still refuses.
   */
  async atomicEnableMfa(userId: string, totpSecret: string): Promise<IUserDocument | null> {
    const current = await this.model
      .findOne({ _id: userId })
      .select('+mfa.totpSecret')
      .lean<{ mfa?: { totpSecret?: string } }>();
    const storedSecret = current?.mfa?.totpSecret;
    if (!storedSecret || decryptAtRest(storedSecret) !== totpSecret) return null;

    const result = await this.model.findOneAndUpdate(
      { _id: userId, 'mfa.totpSecret': storedSecret, 'mfa.totpEnabled': false },
      {
        $set: {
          'mfa.totpEnabled': true,
          'mfa.failedAttempts': 0,
          'mfa.lastUsedAt': new Date(),
          updatedAt: new Date(),
        },
        $unset: { 'mfa.lastFailedAttempt': 1, 'mfa.lockedUntil': 1, 'mfa.pendingBackupCodes': 1 },
      },
      { new: true }
    );
    return result ? result.toJSON() : null;
  }

  async findByStripeCustomerId(stripeCustomerId: string) {
    const result = await this.model.findOne({ stripeCustomerId });
    return result?.toJSON() ?? null;
  }

  async findByIds(ids: string[]) {
    // Drop ids that are not ObjectId-shaped BEFORE convertIds - an unguarded `new ObjectId(id)` throws
    // on anything not 24-hex, which would 500 any caller that passes a non-user id (e.g. a Slack or
    // agent principal id from the lake access trail). A malformed id can never match a real _id anyway.
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];
    return this.model
      .find({ _id: { $in: convertIds(validIds) } })
      .select('name email username lastActiveAt isOnline photoUrl');
  }

  /**
   * What the admin integration-demand requester list shows per user: name, email and the
   * organization the user belongs to today, plus whether the account is soft-deleted (a
   * `deletedAt` is set). Inclusion projection only; a deleted account is returned, not filtered,
   * so the caller can blank it rather than lose the row.
   */
  async findRequesterProfilesByIds(
    ids: string[]
  ): Promise<Array<{ id: string; name?: string; email?: string; organizationId: string | null; deleted: boolean }>> {
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];
    const docs = await this.model
      .find({ _id: { $in: convertIds(validIds) } })
      .select('name email organizationId deletedAt')
      .lean<
        Array<{
          _id: mongoose.Types.ObjectId;
          name?: string;
          email?: string;
          organizationId?: mongoose.Types.ObjectId | null;
          deletedAt?: Date | null;
        }>
      >();
    return docs.map(doc => ({
      id: String(doc._id),
      name: doc.name,
      email: doc.email,
      organizationId: doc.organizationId ? String(doc.organizationId) : null,
      deleted: !!doc.deletedAt,
    }));
  }

  /**
   * Emailed users among `ids`, excluding any that carry `deletedAt` (mirrors the same guard
   * `findBySlackUserId` applies) - narrower than `findByIds` so a notification addressee
   * resolver never mails an emailless account.
   */
  async findActiveEmailsByIds(ids: string[]): Promise<Array<{ id: string; email: string }>> {
    if (ids.length === 0) return [];
    const docs = await this.model
      .find({ _id: { $in: convertIds(ids) }, deletedAt: { $exists: false }, email: { $nin: [null, ''] } })
      .select('email')
      .lean({ virtuals: true });
    return docs.map(d => ({ id: String(d._id), email: String(d.email) }));
  }

  async searchCollections(
    userId: string,
    options: { page: number; limit: number; search: string; type?: CollectionType },
    deps: { findSessionIdsByUserId: (userId: string) => Promise<string[]> }
  ) {
    const { page, limit, search, type } = options;

    const { pipeline, facetStages } = await buildCollectionSearchPipeline(
      { userId, page, limit, search, type },
      { findSessionIdsByUserId: deps.findSessionIdsByUserId }
    );

    // Execute with DocumentDB compatibility
    const result = await executeFacetCompatible(this.model, pipeline, facetStages);

    const totalCount = result[0]?.totalCount?.[0]?.count ?? 0;
    const totalPages = Math.ceil(totalCount / limit);
    const collections = result[0]?.collections ?? [];

    return {
      data: collections,
      meta: {
        totalPages,
        currentPage: page,
        total: totalCount,
      },
    };
  }

  async incrementCredits(userId: string, credits: number, options?: { updateLastCreditsPurchasedAt?: boolean }) {
    console.log(`Incrementing credits for user ${userId} by ${credits}`);
    const result = await this.model.findOneAndUpdate(
      { _id: userId },
      {
        $inc: { currentCredits: credits },
        $set: {
          ...(options?.updateLastCreditsPurchasedAt ? { lastCreditsPurchasedAt: new Date() } : {}),
        },
      },
      { new: true }
    );
    return result;
  }

  /**
   * Debit up to `credits` without taking the balance below zero, in one atomic update: a balance
   * that cannot cover the whole debit is taken to zero (a negative one is left as is). Resolves the
   * credits actually debited, 0 for a missing user, so the caller can see and act on a shortfall.
   */
  async decrementCreditsFloored(userId: string, credits: number): Promise<number> {
    const available = { $max: [{ $ifNull: ['$currentCredits', 0] }, 0] };
    const before = await this.model.findOneAndUpdate(
      { _id: userId },
      [
        {
          $set: {
            currentCredits: { $subtract: [{ $ifNull: ['$currentCredits', 0] }, { $min: [credits, available] }] },
          },
        },
      ],
      { new: false, projection: { currentCredits: 1 } }
    );
    if (!before) return 0;
    return Math.min(credits, Math.max(before.currentCredits ?? 0, 0));
  }

  async incrementCurrentStorage(userId: string, count: number): Promise<void> {
    await this.model.findByIdAndUpdate(
      userId,
      [
        {
          $set: {
            currentStorageSize: { $max: [0, { $add: [{ $ifNull: ['$currentStorageSize', 0] }, count] }] },
          },
        },
      ],
      { new: true }
    );
  }

  async setCurrentStorageIfUnchanged(userId: string, expected: number, next: number): Promise<boolean> {
    // `null` also matches a missing field, which every reader treats as 0.
    const counterFilter = expected === 0 ? { $in: [0, null] } : expected;
    const res = await this.model.updateOne(
      { _id: userId, currentStorageSize: counterFilter },
      { $set: { currentStorageSize: next } }
    );
    return res.matchedCount === 1;
  }

  async findCurrentStorageSize(userId: string): Promise<number | null> {
    if (!mongoose.isValidObjectId(userId)) return null;
    const row = await this.model
      .findById(userId, { currentStorageSize: 1 })
      .lean<{ currentStorageSize?: number | null }>();
    return row ? (row.currentStorageSize ?? 0) : null;
  }

  async listUserIdsAfter(afterId: string | null, limit: number): Promise<string[]> {
    const rows = await this.model
      .find(afterId ? { _id: { $gt: afterId } } : {}, { _id: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean<Array<{ _id: unknown }>>();
    return rows.map(row => String(row._id));
  }

  /**
   * Charge `count` referrals (atomic, floored at zero) and record the invites they created, so a
   * concurrent change to either field is not reverted. Two writes: a pipeline update can't use
   * `$addToSet`, and pipeline values skip Mongoose's ObjectId casting. The invites are recorded
   * first so a failure between the writes under-charges rather than spending quota with no invite.
   * @deprecated Use reserveReferrals before side effects and settleReferrals afterward.
   */
  async recordReferrals(userId: string, count: number, newInviteIds: string[]): Promise<void> {
    if (newInviteIds.length > 0) {
      await this.model.updateOne({ _id: userId }, { $addToSet: { regInvites: { $each: newInviteIds } } });
    }
    await this.model.updateOne({ _id: userId }, [
      {
        $set: {
          numReferralsAvailable: { $max: [0, { $subtract: [{ $ifNull: ['$numReferralsAvailable', 0] }, count] }] },
        },
      },
    ]);
  }

  async reserveReferrals(userId: string, count: number): Promise<boolean> {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid referral reservation count');
    const result = await this.model.updateOne(
      { _id: userId, numReferralsAvailable: { $gte: count } },
      { $inc: { numReferralsAvailable: -count } }
    );
    return result.matchedCount === 1;
  }

  /**
   * Refund only failures before a usable invite exists; delivery failures retain their charge.
   * The refund is a relative $inc not bounded by the current allowance, and it is not idempotent:
   * callers must not retry it.
   */
  async settleReferrals(userId: string, refundCount: number, newInviteIds: string[]): Promise<void> {
    if (!Number.isSafeInteger(refundCount) || refundCount < 0) throw new Error('Invalid referral refund count');
    const result = await this.model.updateOne(
      { _id: userId },
      {
        $inc: { numReferralsAvailable: refundCount },
        $addToSet: { regInvites: { $each: newInviteIds } },
      }
    );
    if (result.matchedCount !== 1) throw new NotFoundError(`User ${userId} not found`);
  }

  async incrementTokenVersion(userId: string): Promise<number> {
    const updated = await this.model.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } }, { new: true });
    // A null result means the user was deleted between the caller's findById and this $inc.
    // Falling back to 0 would report a successful revoke that never happened - fail loudly instead.
    if (!updated) throw new NotFoundError(`User ${userId} not found`);
    return updated.tokenVersion;
  }

  /**
   * Atomically append a moderation hit to a user's record and bump the counters.
   * The `moderation.hits` log is kept newest-first and capped at `MODERATION_HITS_RETAINED`.
   * Does NOT change `moderation.status` - escalation is decided by the policy layer via
   * `setModerationStatus`. Returns the updated document (with the fresh `moderation` state).
   */
  async recordModerationHit(userId: string, hit: IModerationHit): Promise<IUserDocument | null> {
    return this.model.findOneAndUpdate(
      { _id: userId },
      {
        $inc: { 'moderation.hitCount': 1 },
        $set: { 'moderation.lastHitAt': hit.at },
        $push: {
          'moderation.hits': {
            $each: [hit],
            $position: 0,
            $slice: MODERATION_HITS_RETAINED,
          },
        },
      },
      { new: true }
    );
  }

  /**
   * Transition a user's moderation escalation state. `throttledUntil` is set only for `throttled`.
   * Never touches `isModerated`: that is the admin's independent AI-only block, and a status change
   * (a throttle, a lifted suspension) must not silently undo it.
   */
  async setModerationStatus(
    userId: string,
    status: UserModerationStatus,
    options?: { throttledUntil?: Date | null }
  ): Promise<IUserDocument | null> {
    return this.model.findOneAndUpdate(
      { _id: userId },
      {
        $set: {
          'moderation.status': status,
          'moderation.statusChangedAt': new Date(),
          'moderation.throttledUntil': status === 'throttled' ? (options?.throttledUntil ?? null) : null,
        },
      },
      { new: true }
    );
  }

  async setRiskScore(userId: string, riskScore: ISignupRiskScore): Promise<void> {
    const settled = ['approved', 'banned'];
    await this.model.updateOne({ _id: userId }, [
      {
        $set: {
          riskScore: {
            score: riskScore.score,
            // $literal: a reason that happened to start with '$' would otherwise read as a field path.
            signals: { $literal: riskScore.signals },
            computedAt: riskScore.computedAt,
            reviewState: {
              $cond: [
                { $in: [{ $ifNull: ['$riskScore.reviewState', 'none'] }, settled] },
                '$riskScore.reviewState',
                riskScore.reviewState,
              ],
            },
          },
        },
      },
    ]);
  }

  async findRiskScoringCandidateIds(since: Date, options: { afterId?: string; limit: number }): Promise<string[]> {
    const rows = await this.model
      .find(
        {
          createdAt: { $gte: since },
          'riskScore.reviewState': { $nin: ['approved', 'banned'] },
          ...(options.afterId ? { _id: { $gt: new mongoose.Types.ObjectId(options.afterId) } } : {}),
        },
        { _id: 1 }
      )
      .sort({ _id: 1 })
      .limit(options.limit)
      .lean<{ _id: mongoose.Types.ObjectId }[]>()
      .exec();
    return rows.map(row => row._id.toString());
  }

  /**
   * Record a user's moderation appeal: stamps `moderation.appealedAt` and stores the
   * appeal text so admins can review it alongside the user's escalation state. Returns the
   * updated document.
   */
  async recordModerationAppeal(userId: string, appealText: string): Promise<IUserDocument | null> {
    return this.model.findOneAndUpdate(
      { _id: userId },
      { $set: { 'moderation.appealedAt': new Date(), 'moderation.appealText': appealText } },
      { new: true }
    );
  }

  /**
   * Find a user by their Slack user ID
   * Used for OAuth user linking to prevent duplicate Slack ID associations
   */
  async findBySlackUserId(slackUserId: string): Promise<IUserDocument | null> {
    const result = await this.model.findOne({
      'slackSettings.slackUserId': slackUserId,
      ...VERIFIED_SLACK_IDENTITY_FILTER,
      deletedAt: { $exists: false },
    });
    return result?.toJSON() ?? null;
  }
}

const AcquisitionTouchSchema = new Schema(
  {
    source: { type: String, required: true },
    medium: { type: String },
    campaign: { type: String },
    content: { type: String },
  },
  { _id: false }
);

const UserAcquisitionSchema = new Schema(
  {
    firstTouch: { type: AcquisitionTouchSchema, required: false },
    lastTouch: { type: AcquisitionTouchSchema, required: false },
    signupMethod: { type: String, required: true },
    capturedAt: { type: Date, required: true },
  },
  { _id: false }
);

const SignupMetaSchema = new Schema(
  {
    ...NETWORK_META_FIELDS,
    capturedAt: { type: Date, required: true },
  },
  { _id: false }
);

const RiskScoreSchema = new Schema(
  {
    score: { type: Number, required: true },
    signals: [
      new Schema(
        {
          signal: { type: String, required: true, enum: [...SIGNUP_RISK_SIGNALS] },
          points: { type: Number, required: true },
          reason: { type: String, required: true },
        },
        { _id: false }
      ),
    ],
    computedAt: { type: Date, required: true },
    reviewState: { type: String, required: true, enum: [...SIGNUP_RISK_REVIEW_STATES] },
  },
  { _id: false }
);

export const UserSchema = new Schema<IUserDocument, IUserModel>(
  {
    username: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String }, // uniqueness enforced via the partial index below (allows multiple emailless accounts)
    password: { type: String, required: false, select: false },
    // Credential-state flag, NOT inferred from `password` truthiness: admin/migration
    // "shell" accounts store an auto-generated, unusable password (see
    // admin/create-user.ts, reg-invites/migrate.ts) that is bcrypt-hashed and therefore
    // indistinguishable from a real one once written. Passwordless-first (default false);
    // each creation site sets this explicitly based on whether a human actually knows a
    // working password. Gates the SSO auto-link local-email-verified requirement in
    // verifyCallback.ts / okta/callback.ts.
    hasUsablePassword: { type: Boolean, default: false },
    groups: { type: [String], default: [] },
    isAdmin: { type: Boolean, default: false },
    adminPermissions: { type: [String], enum: ADMIN_PERMISSIONS, default: [] },
    storageLimit: { type: Number, default: 1000 }, // Decimal MB
    storageLimitOverride: { type: Number },
    planStorageLimit: { type: Number },
    currentStorageSize: { type: Number, default: 0 }, // Bytes
    currentCredits: { type: Number, default: 0 },
    // Invite-resolved credits awaiting proof of email ownership; paired with
    // the pending-free-credits tag and nulled once granted.
    pendingCreditGrant: { type: Number, default: null },
    // Canonical inbox (canonicalizeEmail) this account claimed its free-credit grant under; unset
    // until a grant is claimed. Unique, so one inbox earns one grant however many aliases sign up.
    freeCreditClaimEmail: { type: String },
    signupGrantAssessment: { type: Schema.Types.Mixed, default: undefined },
    signupGrantHeldReason: { type: String, enum: ['budget_exhausted', null], default: null },
    signupGrant: {
      type: new Schema(
        {
          stage: { type: String, enum: ['pending_email', 'signup', 'unlocked'], required: true },
          signupCredits: { type: Number, min: 0, required: true },
          unlockCredits: { type: Number, min: 0, required: true },
          creditsReleased: { type: Number, min: 0, required: true },
          nextCondition: { type: String, enum: ['email_verification', 'verification', null], default: null },
          unlockedBy: { type: String, enum: SIGNUP_GRANT_UNLOCK_REASONS },
          unlockedOrgId: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
    lastCreditsPurchasedAt: { type: Date, default: null },
    tags: { type: [String], default: [] },
    level: { type: String, default: 'DemoUser' },
    isBanned: { type: Boolean, default: false },
    isModerated: { type: Boolean, default: false },
    apiKeyTrustApproved: { type: Boolean, default: false },
    // Per-user moderation tracking + auto-throttle/suspend state.
    // Lazily populated - undefined until the user's first moderation hit.
    moderation: { type: UserModerationSchema, required: false, default: undefined },
    disputePending: { type: Boolean, required: false, default: false },
    // No pre-save hook required; enforcement is via requireNonSystemUser() helper, not document-level.
    // Queries for human users MUST use { isSystem: { $ne: true } } - default: false does NOT backfill existing docs.
    isSystem: { type: Boolean, default: false },
    subscribedUntil: { type: String, default: null },
    systemFiles: { type: [SystemFileEntrySchema], default: [] },
    oauthCredentials: { type: Object, default: {} },
    authProviders: { type: [AuthProviderSchema], default: [] },
    lastNotebookId: { type: Schema.Types.ObjectId, ref: 'Session' },
    counters: { type: CountersSchema, default: () => ({ counters: [] }) },
    team: { type: String, default: null },
    role: { type: String, default: null },
    phone: { type: String, default: null },
    preferredLanguage: { type: String, default: null },
    preferredContact: { type: String, default: null },
    tshirtSize: { type: String, default: null },
    geoLocation: { type: String, default: null },
    stripeCustomerId: { type: String, default: null },
    securityQuestions: [SecurityQuestionSchema],
    userNotes: [UserNoteSchema],
    numReferralsAvailable: { type: Number, default: 0 },
    regInvites: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    referredByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    loginRecords: [LoginRecordSchema],
    // reset password
    resetPasswordToken: { type: String, default: null },
    resetPasswordSentAt: { type: Date, default: null },
    resetPasswordExpires: { type: Date, default: null },
    // Monotonic kill-switch counter embedded in issued JWTs. Bumped on
    // security-relevant mutations (password reset, MFA change, OAuth unlink)
    // to invalidate every previously-issued token server-side.
    tokenVersion: { type: Number, default: 0 },
    // force password change on first login (admin-created users)
    forcePasswordChangeRequired: { type: Boolean, default: false },

    // AUP/ToS acceptance + 18+ age attestation recorded at account creation (P0-B abuse
    // gate). Top-level so the legal record is server-authoritative. Optional (no `required`)
    // so legacy docs still load; the server middleware treats an absent version as "not accepted"
    // (fail-closed), and the grandfather migration backfills a sentinel for pre-existing accounts.
    // NO `default: null` on purpose: a default would make `toJSON()` materialize the field on every
    // legacy read, so any spread-into-$set update or `user.save()` (e.g. websocket/connect) run
    // BEFORE the backfill would persist `aupAcceptedVersion: null` - which the migration's
    // `$exists: false` branch would then miss, trapping that user on the interstitial. Leaving the
    // path absent keeps legacy docs matchable by the backfill. Readers use a falsy check, so
    // absent vs null is equivalent at the gate.
    aupAcceptedVersion: { type: String },
    aupAcceptedAt: { type: Date },
    ageAttestedAdult: { type: Boolean },

    // email verification
    emailVerified: { type: Boolean, default: false, index: true },
    emailVerificationToken: { type: String, default: null, index: true },
    emailVerificationSentAt: { type: Date, default: null },
    emailVerificationExpires: { type: Date, default: null, index: true },
    emailVerifiedAt: { type: Date, default: null },
    emailVerificationUsed: { type: Boolean, default: null }, // Prevent token reuse

    // pending email change
    pendingEmail: { type: String, default: null },
    pendingEmailToken: { type: String, default: null, index: true },
    pendingEmailSentAt: { type: Date, default: null },
    pendingEmailExpires: { type: Date, default: null, index: true },
    pendingEmailUsed: { type: Boolean, default: null }, // Prevent token reuse

    googleDrive: {
      default: null,
      type: {
        accessToken: { type: String, required: true },
        refreshToken: { type: String, required: false },
        expiresAt: { type: Date, required: true },
      },
    },

    atlassianConnect: {
      default: null,
      type: {
        accessToken: { type: String, required: true },
        refreshToken: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        siteName: { type: String, required: false }, // Not required during pending_site_selection
        resources: [
          {
            id: { type: String, required: true },
            name: { type: String, required: true },
            url: { type: String, required: true },
            scopes: { type: [String], required: true },
            resourceType: { type: String, required: false },
            productType: { type: String, required: false },
          },
        ],
        connectedAt: { type: Date, default: Date.now },
        status: {
          type: String,
          enum: ['connected', 'needs_reconnect', 'pending_site_selection'],
          default: 'connected',
        },
        disconnectReason: { type: String, required: false },
        selectedResourceId: { type: String, required: false },
        pendingSelectionExpiresAt: { type: Date, required: false },
      },
    },

    notionConnect: {
      default: null,
      type: NotionConnectSchema,
    },

    /** Single-use nonce for Notion OAuth; set at connect, consumed at callback. */
    pendingNotionOAuthNonce: { type: String, required: false, select: false },

    blogIntegration: {
      default: null,
      type: {
        apiKey: { type: String, required: true },
        baseUrl: { type: String, required: true },
        defaultAuthor: { type: String, required: false },
        defaultTags: { type: [String], required: false },
        connectedAt: { type: Date, default: Date.now },
      },
    },

    // Token rotation tracking per integration
    integrationRotation: {
      default: {},
      type: {
        github: {
          lastRotationInitiatedAt: { type: Date, required: false },
          lastRotationReason: { type: String, required: false },
          _id: false,
        },
        atlassian: {
          lastRotationInitiatedAt: { type: Date, required: false },
          lastRotationReason: { type: String, required: false },
          _id: false,
        },
        slack: {
          lastRotationInitiatedAt: { type: Date, required: false },
          lastRotationReason: { type: String, required: false },
          _id: false,
        },
        notion: {
          lastRotationInitiatedAt: { type: Date, required: false },
          lastRotationReason: { type: String, required: false },
          _id: false,
        },
        _id: false,
      },
    },

    lastActiveAt: { type: Date },
    isOnline: { type: Boolean, default: false },

    mementos: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Memento',
        default: [],
      },
    ],
    photoUrl: { type: String, default: null },

    // Slack integration settings
    slackSettings: {
      slackUserId: { type: String, required: false },
      slackTeamId: { type: String, required: false },
      slackUserToken: { type: String, required: false, select: false }, // User token for reminders API (protected by select: false)
      slackUserScopes: { type: [String], required: false, default: [] }, // OAuth scopes granted by user
      defaultNotebookId: { type: String, required: false },
      autoCreateNotebook: { type: Boolean, required: false, default: true },
      notebookNamePrefix: { type: String, required: false, default: 'Slack Chat' },
      lastUsedAgent: { type: String, required: false },
      defaultProjectId: { type: String, required: false }, // Optional project for auto-created notebooks
      // Per-agent notebook routing (optional)
      agentNotebookRouting: {
        dev: { type: String, required: false },
        pm: { type: String, required: false },
        analyst: { type: String, required: false },
        researcher: { type: String, required: false },
        agent: { type: String, required: false },
      },
      keywordRouting: { type: [KeywordRoutingRuleSchema], required: false, default: [] },
      customAgentId: { type: String, required: false }, // User's custom agent for @agent command
      githubNotifications: {
        enabled: { type: Boolean, required: false, default: false },
        githubUsername: { type: String, required: false },
        prOpened: { type: Boolean, required: false, default: true },
        prReviewRequested: { type: Boolean, required: false, default: true },
        prApproved: { type: Boolean, required: false, default: true },
        prChangesRequested: { type: Boolean, required: false, default: true },
        prMerged: { type: Boolean, required: false, default: true },
        ciFailed: { type: Boolean, required: false, default: true },
        ciPassed: { type: Boolean, required: false, default: false },
        mentions: { type: Boolean, required: false, default: true },
        channels: {
          default: { type: String, required: false },
          ciAlerts: { type: String, required: false },
        },
        lastNotificationAt: { type: Date, required: false },
        notificationCount: { type: Number, required: false, default: 0 },
      },
    },

    // MFA (Multi-Factor Authentication) field
    mfa: { type: MFASchema, default: null },
    // Last accepted TOTP time step (unix seconds / 30), see IUser.totpLastStep.
    totpLastStep: { type: Number, default: null },

    // User preferences
    showCreditsUsed: { type: Boolean, default: true },

    // Email Integration (Email-to-Platform Ingestion)
    platformEmailAddress: { type: String, unique: true, sparse: true },
    authorizedEmailAddresses: { type: [String], default: [] },
    preferredVoice: { type: String, default: null },
    voiceOverrideId: { type: String, default: null },
    voiceSystemPromptOverride: { type: String, default: null },
    preferredReasoningEffort: {
      type: String,
      enum: ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      default: 'auto',
    },

    // Cross-device user preferences (synced from client localStorage). Defaults to null, not
    // {} - a dot-path $set (e.g. 'preferences.foo') on a user who has never set a preference
    // fails with "Cannot create field 'foo' in element {preferences: null}"; coerce to {} in
    // a separate update first (see docx-template.ts) before writing a nested path.
    preferences: { type: UserPreferencesSchema, default: null },

    lastCreditGrantAt: { type: Date, required: false },

    // Written once at signup, consent-gated - see IUser.acquisition.
    acquisition: { type: UserAcquisitionSchema, required: false, default: undefined },
    // Written once at signup - see IUser.signupMeta.
    signupMeta: { type: SignupMetaSchema, required: false, default: undefined },
    // Recomputed by userService.refreshSignupRiskScore - see IUser.riskScore.
    riskScore: { type: RiskScoreSchema, required: false, default: undefined },
    isSynthetic: { type: Boolean, required: false },
    firstValueAt: { type: Date, required: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Dedupe key for an authProviders entry: strategy and id joined by a U+0000 delimiter, a
// byte no legitimate strategy or id contains - nothing schema-level enforces this (the
// strategy enum blocks it on validated paths; id has no validator), but no real value
// carries it. Written as an escape (not a raw NUL) so the file stays greppable; see #1221.
// Exported so the delimiter's separating property is unit-tested directly (see
// UserModel.test.ts).
export const authProviderDedupeKey = (strategy: AuthStrategy, id: string | null): string =>
  `${strategy}\u0000${id ?? ''}`;

// Duplicate-(strategy, id) integrity guard for authProviders. A concurrent
// first-login race (two logins racing stage-1 miss -> stage-2 miss, see
// verifyCallback.ts) can try to persist the same provider identity twice on
// one user; the authProviders_strategy_id index below is deliberately
// NON-unique (legacy id:null rows), so the guard lives here at the app level.
// Dedupes rather than rejects so pre-existing duplicate rows self-heal on the
// next save instead of locking the account out. Later entries win: they carry
// the freshest tokens. Complements the same-strategy collapse in
// oauthAccountLink.ts applyAccountLink(), which covers the updateOne link path
// this save hook never sees.
UserSchema.pre('save', function (next) {
  const providers = this.authProviders;
  if (Array.isArray(providers) && providers.length > 1) {
    const lastIndexByKey = new Map<string, number>();
    providers.forEach((p, i) => lastIndexByKey.set(authProviderDedupeKey(p?.strategy, p?.id), i));
    if (lastIndexByKey.size !== providers.length) {
      this.authProviders = providers.filter(
        (p, i) => lastIndexByKey.get(authProviderDedupeKey(p?.strategy, p?.id)) === i
      );
    }
  }
  next();
});

// Stripe-customer resolution for business metrics.
UserSchema.index({ stripeCustomerId: 1 }, { name: 'user_stripeCustomerId' });

// This will support the $or queries in findByUsernameOrEmail efficiently
UserSchema.index({
  username: 1,
  email: 1,
});

// email is unique only when it is actually present as a string. A plain unique
// index treats every null/absent email as the SAME value, so only one emailless
// account could exist - every subsequent OAuth/SSO signup without an email (e.g.
// a private GitHub email) collided with E11000 on `email_1`. The partial filter
// scopes uniqueness to real emails and excludes emailless docs from the index.
// Existing deployments are migrated by 20260619000000_user-email-partial-unique-index.
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'email_1' }
);

// One free-credit grant per inbox: see claimFreeCreditGrant. Partial so unclaimed accounts are
// not indexed. Existing deployments are backfilled and indexed by migration 20260921235965.
UserSchema.index(
  { freeCreditClaimEmail: 1 },
  {
    unique: true,
    partialFilterExpression: { freeCreditClaimEmail: { $type: 'string' } },
    name: 'freeCreditClaimEmail_1',
  }
);

// Case-insensitive email index for collation-based lookups (findByEmail).
// The existing email_1 index is case-sensitive and won't be used by .collation() queries.
UserSchema.index(
  { email: 1 },
  {
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { email: { $type: 'string' } },
    name: 'email_ci',
  }
);

// Case-insensitive username index for collation-based lookups (findAllByEmailsOrUsernames).
// Same reasoning as email_ci above: the case-sensitive username_1 index above won't be used
// by a .collation() query, and without a matching collated index that $in falls back to a
// full collection scan.
UserSchema.index({ username: 1 }, { collation: { locale: 'en', strength: 2 }, name: 'username_ci' });

// resetPasswordToken index intentionally removed - password reset flow replaced by OTC email auth
// Non-unique multikey index for the two-stage OAuth lookup (stage-1 matches by provider identity).
// NOT unique: legacy rows carry id:null; a unique multikey would collide every (strategy, null).
// Explicit name MUST match migration 20260620000000's createIndex name, otherwise autoIndex
// (mongo.ts) and the migrator create the same key pattern under two names -> IndexKeySpecsConflict.
UserSchema.index({ 'authProviders.strategy': 1, 'authProviders.id': 1 }, { name: 'authProviders_strategy_id' });
// Serves the group-membership reads added by org-groups #1172: the per-group memberCount on
// GET /organizations/:id/groups and the $pull in removeGroupsFromAllUsers on group-type revoke.
// Without it both scan the full users collection. Explicit name so the migration and autoIndex
// (mongo.ts) agree - see the authProviders_strategy_id note above.
UserSchema.index({ groups: 1 }, { name: 'user_groups' });
UserSchema.index({ createdAt: 1, 'signupMeta.ja4': 1 }, { name: 'user_signup_fingerprint_window' });
// Serves the forward member lookup in OrganizationRepository.findMemberUserIds, which the org
// feedback report and its drill-down routes call on every request. Without it that read scans the
// full users collection. Explicit name so the migration and autoIndex (mongo.ts) agree - see the
// authProviders_strategy_id note above.
UserSchema.index({ organizationId: 1 }, { name: 'user_organizationId' });
// Serves the per-organization org_invite unlock cap (apps/client/server/credits/orgInviteUnlock.ts).
// Sparse: only accounts an org invite unlocked carry the field. Explicit name so the migration
// 20260921235968 and autoIndex (mongo.ts) agree.
UserSchema.index({ 'signupGrant.unlockedOrgId': 1 }, { sparse: true, name: 'signupGrant_unlockedOrgId' });
UserSchema.index({ createdAt: 1 });
// Serves the signupIpRetention cron's range scan for signups past the retention window. Sparse:
// accounts created before signup network capture carry no signupMeta. Explicit name so migration
// 20260921235973 and autoIndex agree - see the authProviders_strategy_id note above.
UserSchema.index({ 'signupMeta.capturedAt': 1 }, { name: 'user_signupMeta_capturedAt', sparse: true });
UserSchema.index({ 'slackSettings.slackUserId': 1 });
UserSchema.index({ 'slackSettings.githubNotifications.githubUsername': 1 });
UserSchema.index({ 'atlassianConnect.status': 1 });
UserSchema.index({ 'notionConnect.status': 1 });
// Admin users list: the Signed up, Last active and Credits sorts and the built-in view counts
// (apps/client/server/admin/usersList/listAdminUsers.ts). The sort keys end in _id because
// adminUsersSort adds an _id tiebreak, and a sort only uses an index whose key it prefixes; each
// serves both directions. The flag and band indexes are partial/sparse so they stay small. Built
// by the ensure-user-admin-list-indexes migration.
UserSchema.index({ createdAt: -1, _id: -1 }, { name: 'user_createdAt_id' });
UserSchema.index({ lastActiveAt: -1, _id: -1 }, { name: 'user_lastActiveAt_id' });
UserSchema.index({ currentCredits: -1, _id: -1 }, { name: 'user_currentCredits_id' });
UserSchema.index({ isBanned: 1 }, { partialFilterExpression: { isBanned: true }, name: 'user_isBanned_true' });
UserSchema.index({ 'signupGrantAssessment.band': 1 }, { sparse: true, name: 'user_signupGrantAssessment_band' });
// platformEmailAddress index is already created by the 'unique: true' option in the schema definition

// Add text index for fast user search in admin panel
UserSchema.index(
  { username: 'text', email: 'text', name: 'text' },
  {
    weights: { username: 10, name: 5, email: 2 },
    background: true,
    name: 'user_search_text',
  }
);

// TODO: Move to a utility file
export const validatePassword = async function (user: IUserDocument, password: string): Promise<boolean> {
  return !!user.password && bcrypt.compare(password, user.password);
};

// TODO: Move to a utility file
export const changeStorageSize = async function (user: IUserDocument, size: number) {
  user.currentStorageSize += size;

  // Prevent negative storage size
  if (user.currentStorageSize < 0) {
    user.currentStorageSize = 0;
  }
};

/**
 * Update pipeline counting one MFA attempt at `now`. Stage 1 increments failedAttempts, resetting
 * to 1 when the last failure is older than the reset window; stage 2 sets lockedUntil from stage
 * 1's output, so the increment and the lockout land in one atomic write.
 */
function mfaAttemptPipeline(now: Date): PipelineStage.Set[] {
  return [
    {
      $set: {
        'mfa.failedAttempts': {
          $cond: {
            if: {
              $and: [
                { $gt: [{ $ifNull: ['$mfa.lastFailedAttempt', null] }, null] },
                {
                  $gt: [
                    { $subtract: [now, { $ifNull: ['$mfa.lastFailedAttempt', now] }] },
                    MFA_ATTEMPT_RESET_WINDOW_MS,
                  ],
                },
              ],
            },
            then: 1,
            else: { $add: [{ $ifNull: ['$mfa.failedAttempts', 0] }, 1] },
          },
        },
        'mfa.lastFailedAttempt': now,
      },
    },
    {
      $set: {
        'mfa.lockedUntil': {
          $cond: {
            if: { $gte: ['$mfa.failedAttempts', MFA_MAX_FAILED_ATTEMPTS] },
            then: new Date(now.getTime() + MFA_LOCKOUT_DURATION_MS),
            else: '$$REMOVE',
          },
        },
      },
    },
  ];
}

/**
 * Structural guard for the select:false MFA secrets (`mfa.totpSecret` / `mfa.backupCodes`).
 *
 * Because those fields are select:false, any read other than `findByIdWithMfaSecrets` returns an
 * `mfa` subdocument WITHOUT them. Persisting such a subdocument via an update - repository writes
 * (`$set: { mfa }`) OR direct model calls (`User.updateOne(filter, { mfa })`, `findByIdAndUpdate`) -
 * would REPLACE the stored subdocument and erase the secrets while leaving `totpEnabled: true`,
 * permanently bricking MFA. Update operations run no document validators, so the schema's
 * `required: true` on `totpSecret` does not catch it.
 *
 * This query middleware strips any `mfa` value that is an object lacking `totpSecret` (a
 * secret-less echo) from the update - in both `$set` and top-level forms - so the stored
 * subdocument is left untouched. It sits at the schema layer (not the repository) so it covers
 * every write path, present and future. Deliberate MFA writes load the secrets first
 * (`findByIdWithMfaSecrets`) and therefore carry `totpSecret`, so they pass through unchanged;
 * deliberate teardowns pass `mfa: null` (falsy, not an object), which also passes through.
 */
function stripSecretlessMfaFromUpdate(this: Query<unknown, IUserDocument>) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) return;
  const isSecretlessMfa = (value: unknown): boolean =>
    !!value && typeof value === 'object' && !(value as { totpSecret?: string }).totpSecret;

  if (isSecretlessMfa(update.mfa)) {
    delete update.mfa;
  }
  const set = update.$set as Record<string, unknown> | undefined;
  if (set && isSecretlessMfa(set.mfa)) {
    delete set.mfa;
  }
  this.setUpdate(update);
}

/**
 * Encrypts `mfa.totpSecret` (and `mfa.pendingBackupCodes`) on every update that writes it, so a
 * read-only DB or backup exposure cannot mint second-factor codes. Covers the whole-subdocument forms (`{ mfa }`, `$set: { mfa }`)
 * that setupMFA and the snapshot writers (passkey authenticate, regenerate-backup-codes) use, and the
 * dotted `mfa.totpSecret` form. encryptAtRest leaves ciphertext untouched, so re-writing an
 * already-encrypted value is a no-op. Must stay in sync with the decrypt in findByIdWithMfaSecrets.
 */
const MFA_ENCRYPTED_FIELDS = ['totpSecret', 'pendingBackupCodes'] as const;

function encryptTotpSecretInUpdate(this: Query<unknown, IUserDocument>) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update || Array.isArray(update)) return;

  const encrypt = (value: string) => (isEncrypted(value) ? value : encryptAtRest(value));
  const encryptIn = (container: Record<string, unknown> | undefined) => {
    if (!container) return;
    const mfa = container.mfa as Record<string, unknown> | null | undefined;
    if (mfa && typeof mfa === 'object') {
      const encrypted = { ...mfa };
      for (const field of MFA_ENCRYPTED_FIELDS) {
        if (typeof encrypted[field] === 'string') encrypted[field] = encrypt(encrypted[field]);
      }
      container.mfa = encrypted;
    }
    for (const field of MFA_ENCRYPTED_FIELDS) {
      const dotted = container[`mfa.${field}`];
      if (typeof dotted === 'string') container[`mfa.${field}`] = encrypt(dotted);
    }
  };

  encryptIn(update);
  encryptIn(update.$set as Record<string, unknown> | undefined);
  this.setUpdate(update);
}

UserSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], stripSecretlessMfaFromUpdate);

const isHashedAnswer = (answer: string): boolean => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(answer);
async function hashSecurityQuestions(questions: unknown): Promise<void> {
  if (!Array.isArray(questions)) return;
  if (questions.length > 10) throw new Error('At most 10 security questions are allowed');
  for (const question of questions) {
    if (typeof question !== 'object' || question === null || typeof question.answer !== 'string') continue;
    if (question.answer.length > 1024) throw new Error('Security answer is too long');
    if (!isHashedAnswer(question.answer)) question.answer = await bcrypt.hash(question.answer, 12);
  }
}

UserSchema.pre('validate', async function () {
  if (this.isModified('securityQuestions')) await hashSecurityQuestions(this.securityQuestions);
});
UserSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], async function () {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) return;
  for (const container of [update, update.$set, update.$setOnInsert]) {
    if (!container || typeof container !== 'object') continue;
    await hashSecurityQuestions(container.securityQuestions);
    for (const [path, value] of Object.entries(container)) {
      if (!/^securityQuestions\.[^.]+\.answer$/.test(path) || typeof value !== 'string') continue;
      if (value.length > 1024) throw new Error('Security answer is too long');
      container[path] = isHashedAnswer(value) ? value : await bcrypt.hash(value, 12);
    }
  }
});

UserSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], encryptTotpSecretInUpdate);

// The document-save counterpart of encryptTotpSecretInUpdate (User.create / doc.save()).
UserSchema.pre('save', function (next) {
  if (this.mfa?.totpSecret && !isEncrypted(this.mfa.totpSecret) && this.isModified('mfa.totpSecret')) {
    this.mfa.totpSecret = encryptAtRest(this.mfa.totpSecret);
  }
  const pendingCodes = this.mfa?.pendingBackupCodes;
  if (pendingCodes && !isEncrypted(pendingCodes) && this.isModified('mfa.pendingBackupCodes')) {
    this.mfa!.pendingBackupCodes = encryptAtRest(pendingCodes);
  }
  next();
});

export const User =
  (mongoose.models.User as unknown as IUserModel) ?? model<IUserDocument, IUserModel>('User', UserSchema);
export default User;

export const userRepository = new UserRepository(User);
