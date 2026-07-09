import {
  CollectionType,
  ISecurityQuestion,
  IUserDocument,
  IUserRepository,
  IUserNote,
  IModerationHit,
  UserModerationStatus,
} from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import mongoose, { Document, Model, model, Schema, Query } from 'mongoose';
import { convertIds } from '../../utils/mongo';
import { CountersSchema } from '../infra/ops/CounterModel';
import BaseRepository from '@bike4mind/db-core';
import { executeFacetCompatible } from '../../utils/documentdb-compat';
import { buildCollectionSearchPipeline } from '../../queries/collectionSearchQuery';

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    // Plaintext TOTP secret + backup codes - never serialize to a client. select:false
    // keeps them out of every default query/response; the MFA subsystem loads them
    // explicitly via findByIdWithMfaSecrets (+select). `totpEnabled` (not select:false)
    // is the flag callers use to detect that MFA is configured.
    totpSecret: { type: String, required: true, select: false },
    totpEnabled: { type: Boolean, default: false },
    backupCodes: { type: [String], default: [], select: false },
    setupAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    // Server-side attempt tracking (can't be bypassed by refresh/cancel)
    failedAttempts: { type: Number, default: 0 },
    lastFailedAttempt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
  },
  { _id: false }
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
    source: { type: String, enum: ['openai', 'bedrock'], required: true },
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

  async findAllByEmailsOrUsernames(emails: string[], usernames: string[]) {
    const result = await this.model.find({
      $or: [{ email: { $in: emails } }, { username: { $in: usernames } }],
    });
    return result.map(d => d.toJSON());
  }

  async findByUsernameOrEmail(username: string, email: string) {
    const escapedUsername = escapeRegExp(username);
    const query = {
      $or: [{ username: { $regex: `^${escapedUsername}$`, $options: 'i' } }, { email }],
    };

    const result = await this.model.findOne(query).collation({ locale: 'en', strength: 2 }).select('+password');

    return result?.toJSON() ?? null;
  }

  async findByEmail(email: string) {
    return this.model.findOne({ email }).collation({ locale: 'en', strength: 2 });
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

  /** Loads a user WITH the select:false MFA secrets - for server-side MFA verification only. */
  async findByIdWithMfaSecrets(id: string): Promise<IUserDocument | null> {
    const result = await this.model.findOne({ _id: id }).select('+mfa.totpSecret +mfa.backupCodes');
    return result ? result.toJSON() : null;
  }

  /**
   * Atomically increment the MFA failed-attempt counter and conditionally set the lockout.
   * Uses a two-stage MongoDB aggregation pipeline update so the increment and lockout write
   * are a single atomic operation - a read-modify-write would allow concurrent requests to
   * each read the same count and undercount failures, defeating the 3-strike lockout.
   *
   * Policy constants are co-located with the DB method rather than imported from the auth
   * package (which depends on this package) to keep the dependency direction correct.
   * They must match `MAX_FAILED_ATTEMPTS` / `LOCKOUT_DURATION_MS` / `ATTEMPT_RESET_WINDOW_MS`
   * in `b4m-core/auth/src/mfaService/utils.ts`.
   */
  async atomicRecordMfaFailedAttempt(userId: string): Promise<IUserDocument | null> {
    const MFA_MAX_FAILED_ATTEMPTS = 3;
    const MFA_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
    const MFA_ATTEMPT_RESET_WINDOW_MS = 60 * 60 * 1000;

    const now = new Date();
    const lockoutUntil = new Date(now.getTime() + MFA_LOCKOUT_DURATION_MS);

    // Stage 1: increment failedAttempts, resetting to 1 if the last failure was over an hour ago.
    // Stage 2: conditionally set lockedUntil from stage 1's output (same pipeline, atomic).
    const result = await this.model.findOneAndUpdate(
      { _id: userId },
      [
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
                then: 1, // stale window — reset counter, this attempt is attempt #1
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
                then: lockoutUntil,
                else: '$$REMOVE',
              },
            },
          },
        },
      ],
      { new: true }
    );

    return result ? result.toJSON() : null;
  }

  async findByStripeCustomerId(stripeCustomerId: string) {
    const result = await this.model.findOne({ stripeCustomerId });
    return result?.toJSON() ?? null;
  }

  async findByIds(ids: string[]) {
    return this.model
      .find({ _id: { $in: convertIds(ids) } })
      .select('name email username lastActiveAt isOnline photoUrl');
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
   * Transition a user's moderation escalation state. When moving to `suspended`,
   * also mirrors `isModerated: true` so legacy admin surfaces reflect the suspension; any
   * non-suspended status clears that mirror. `throttledUntil` is set only for `throttled`.
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
          isModerated: status === 'suspended',
        },
      },
      { new: true }
    );
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
      deletedAt: { $exists: false },
    });
    return result?.toJSON() ?? null;
  }
}

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
    storageLimit: { type: Number, default: 1000 }, // MBs
    currentStorageSize: { type: Number, default: 0 }, // Bytes
    currentCredits: { type: Number, default: 0 },
    // Invite-resolved credits awaiting proof of email ownership; paired with
    // the pending-free-credits tag and nulled once granted.
    pendingCreditGrant: { type: Number, default: null },
    lastCreditsPurchasedAt: { type: Date, default: null },
    tags: { type: [String], default: [] },
    level: { type: String, default: 'DemoUser' },
    isBanned: { type: Boolean, default: false },
    isModerated: { type: Boolean, default: false },
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
    authProviders: { type: Array, default: [] },
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

    // User preferences
    showCreditsUsed: { type: Boolean, default: false },

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

    // Cross-device user preferences (synced from client localStorage)
    preferences: { type: UserPreferencesSchema, default: null },

    lastCreditGrantAt: { type: Date, required: false },
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

// resetPasswordToken index intentionally removed - password reset flow replaced by OTC email auth
// Non-unique multikey index for the two-stage OAuth lookup (stage-1 matches by provider identity).
// NOT unique: legacy rows carry id:null; a unique multikey would collide every (strategy, null).
// Explicit name MUST match migration 20260620000000's createIndex name, otherwise autoIndex
// (mongo.ts) and the migrator create the same key pattern under two names -> IndexKeySpecsConflict.
UserSchema.index({ 'authProviders.strategy': 1, 'authProviders.id': 1 }, { name: 'authProviders_strategy_id' });
UserSchema.index({ 'slackSettings.slackUserId': 1 });
UserSchema.index({ 'slackSettings.githubNotifications.githubUsername': 1 });
UserSchema.index({ 'atlassianConnect.status': 1 });
UserSchema.index({ 'notionConnect.status': 1 });
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

UserSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], stripSecretlessMfaFromUpdate);

export const User =
  (mongoose.models.User as unknown as IUserModel) ?? model<IUserDocument, IUserModel>('User', UserSchema);
export default User;

export const userRepository = new UserRepository(User);
