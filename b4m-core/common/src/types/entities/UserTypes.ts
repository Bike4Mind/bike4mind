import { IBaseRepository, IMongoDocument } from '.';
import { ISessionDocument } from './SessionTypes';
import { IRegInviteDocument } from './RegistrationInviteType';
import { IOrganizationDocument } from './OrganizationTypes';
import { ICounters } from './CounterTypes';
import { IMementoDocument } from './MementoTypes';
import { ICreditHolder, ICreditHolderMethods } from './CreditHolderTypes';
import { PaginatedResponse, UserReasoningEffort } from '../common';

export enum CollectionType {
  NOTEBOOK = 'notebook',
  KNOWLEDGE = 'knowledge',
  PROJECT = 'project',
  AI_IMAGE = 'ai_image',
}

export interface Collection {
  id: string;
  type: CollectionType;
  name: string;
  updatedAt: Date;
  tags: string[];
  imageUrl?: string; // Optional field for image collections
}

export interface ISystemFileEntry {
  fileId: string;
  enabled: boolean;
}

export interface ILoginRecord {
  loginTime: Date;
  logoutTime?: Date; // Optional, in case the user doesn't explicitly logout
  userAgent: string;
  browser: string;
  operatingSystem: string;
  deviceType: string; // e.g., 'Mobile', 'Desktop', 'Tablet'
  screenResolution: string;
  viewportSize: string;
  colorDepth: number;
  pixelDepth: number;
  devicePixelRatio: number;
  ip?: string | '0.0.0.0'; // Collected server-side for accuracy and privacy
  location?: string; // Optional, more precise location if available/appropriate
  networkType?: string; // e.g., 'wifi', '4g'
}

export type UserLevelType = 'DemoUser' | 'PaidUser' | 'VIPUser' | 'ManagerUser' | 'AdminUser';

export const ROTATABLE_INTEGRATIONS = ['github', 'atlassian', 'slack', 'notion'] as const;
export type RotatableIntegration = (typeof ROTATABLE_INTEGRATIONS)[number];
export interface ISecurityQuestion {
  question: string;
  answer: string;
}

export interface IUserNote {
  timestamp: string;
  note: string;
  userName: string; // Who updated the note
}

export interface IKeywordRoutingRule {
  keywords: string[];
  notebookId: string;
}

/**
 * Use this on client side, it excludes Mongoose specific properties
 * that will not be present on the client side.
 */
export interface IMFAConfig {
  totpSecret: string;
  totpEnabled: boolean;
  backupCodes: string[];
  setupAt: Date;
  lastUsedAt?: Date;
  // Server-side attempt tracking (can't be bypassed by refresh/cancel)
  failedAttempts?: number;
  lastFailedAttempt?: Date;
  lockedUntil?: Date;
}

/**
 * User preferences that are synced to the database for cross-device persistence.
 * All fields are optional - missing/null means "use default".
 */
export interface IUserPreferences {
  language?: string;
  favoriteTags?: string[];
  favoriteModelIds?: string[];
  fileBrowserViewMode?: 'home' | 'list' | 'grid' | 'tags';
  optiSessionId?: string | null;
  lastUsedTextModel?: string | null;
  lastUsedImageModel?: string | null;
  lastUsedImageEditModel?: string | null;
  showDebug?: boolean;
  showHelp?: boolean;
  maxVisibleLines?: number;
  autoCollapseContent?: boolean;
  enableAutoScroll?: boolean;
  scrollbarWidth?: number;
  experimentalFeatures?: Partial<Record<string, boolean>>;
  contextTelemetryLevel?: 'none' | 'basic' | 'enhanced';
  /** ISO timestamp of last telemetry consent change (GDPR Article 7(3) proof) */
  contextTelemetryConsentedAt?: Date;
  rechartsDisplayMode?: 'inline' | 'artifact';
  /** Whether the Smart Tools catalog ("Individual tools") starts collapsed in the composer dropdown. Default: expanded. */
  toolsCatalogCollapsed?: boolean;
  /** File ID of the user's custom DOCX export template */
  docxTemplateFileId?: string | null;
  /**
   * Default behavior of the Agent-mode composer toggle.
   * Layer-2 of the two-layer gating: only takes effect when the Layer-1 gate
   * resolves true via `useFeatureEnabled('agentMode')` (admin `EnableAgentMode`
   * plus per-user pref / admin default).
   * - `off`: agent_executor disabled even on @-mention paths (feature flag off)
   * - `auto`: classifier may route to agent_executor on complex queries
   * - `on`: agent_executor used by default; toggle starts in the ON state
   */
  agentModeDefault?: 'off' | 'auto' | 'on';
}

/** Source of a moderation flag - which moderation backend produced the hit. */
export type ModerationHitSource = 'openai' | 'bedrock';

/**
 * Escalation state for a user's moderation record.
 * - `active`: no action; normal usage.
 * - `throttled`: auto-applied on repeat hits; a tighter rate limit is enforced until `throttledUntil`.
 * - `suspend_pending`: threshold for suspension reached - flagged for a human to confirm. NOT auto-blocking.
 * - `suspended`: human-confirmed suspension; chat/generation is blocked (mirrored to `isModerated`).
 */
export type UserModerationStatus = 'active' | 'throttled' | 'suspend_pending' | 'suspended';

/** A single moderation flag recorded against a user. */
export interface IModerationHit {
  /** When the prompt was flagged. */
  at: Date;
  /** Flagged category labels (e.g. `hate`, `violence`) reported by the moderation backend. */
  categories: string[];
  /** Which moderation backend produced the hit. */
  source: ModerationHitSource;
  /** The quest whose prompt was flagged, when available. */
  questId?: string;
}

/**
 * Per-user moderation tracking + auto-throttle/suspend state.
 * Catches repeat offenders before the LLM provider does. Populated lazily -
 * absent until a user's first moderation hit.
 */
export interface IUserModeration {
  /** Lifetime count of moderation hits (monotonic; not window-scoped). */
  hitCount: number;
  /** Timestamp of the most recent hit, or null if none. */
  lastHitAt: Date | null;
  /** Recent hits, newest-first, bounded to the most recent `MODERATION_HITS_RETAINED`. */
  hits: IModerationHit[];
  /** Current escalation state. */
  status: UserModerationStatus;
  /** When `status` last changed. */
  statusChangedAt: Date | null;
  /** While `throttled`, the instant the throttle expires. */
  throttledUntil: Date | null;
  /** When the user last submitted an appeal, or null if none. */
  appealedAt?: Date | null;
  /** The most recent appeal message the user submitted, surfaced to admins for review. */
  appealText?: string | null;
}

export interface IUser extends ICreditHolder {
  id: string;
  username: string;
  name: string;
  email: string | null;
  password: string | null;
  groups: Array<string> | null;
  isAdmin: boolean;
  storageLimit: number /** Storage limit in MBs */;
  currentStorageSize: number /** Current storage size in Bytes */;
  tags: Array<string> | null;
  /**
   * Invite-resolved credit amount awaiting proof of email ownership. Set at
   * registration alongside PENDING_FREE_CREDITS_TAG; released (and nulled) by
   * registerViaOTC or the email-verify route. Null when nothing is pending - the
   * open-registration path leaves it null and grants `defaultFreeCredits` instead.
   */
  pendingCreditGrant?: number | null;
  level: UserLevelType;
  isBanned: boolean;
  isModerated: boolean;
  /**
   * Per-user moderation tracking + auto-throttle/suspend state.
   * Absent until the user's first moderation hit. `moderation.status === 'suspended'`
   * is mirrored to `isModerated` for legacy admin surfaces.
   */
  moderation?: IUserModeration;
  /**
   * Set to true when a Stripe dispute (chargeback) is opened against this user.
   * Blocks chat completions and API key access until resolved by an admin.
   */
  disputePending?: boolean;
  /**
   * Marks a non-human system account (e.g., the Overwatch ingest user).
   * All auth surfaces must call requireNonSystemUser() - system accounts cannot log in.
   * Queries for human users must use { isSystem: { $ne: true } } - default: false does NOT backfill existing docs.
   */
  isSystem?: boolean;
  subscribedUntil: string | null;
  photoUrl: string | null;

  /**
   * Multi-Factor Authentication configuration
   */
  mfa: IMFAConfig | null;

  /**
   * The IDs of the system files that the user has created and enabled on their profile
   * In general, these are CRUD editable by the user with priority 501-999
   */
  systemFiles: ISystemFileEntry[] | null;

  /**
   * @todo This needs to be refactored to be an array of Oauth credentials.
   * Right now, it only supports one set of credentials, which is not ideal.
   */
  oauthCredentials: IOAuthCredentials | null;
  authProviders: Array<IAuthProviders> | null;

  lastNotebookId: ISessionDocument['id'] | null;
  /** @deprecated Will be removed in future versions. Please use UserActivityCounter instead */
  counters?: ICounters | null;
  team: string | null;
  role: string | null;
  phone: string | null;
  preferredLanguage: string | null;
  preferredContact: string | null;
  tshirtSize: string | null;
  geoLocation: string | null;
  stripeCustomerId: string | null;
  securityQuestions: Array<ISecurityQuestion> | null;
  userNotes: Array<IUserNote> | null;
  loginRecords: Array<ILoginRecord> | null;

  // reset password
  resetPasswordToken: string | null;
  resetPasswordSentAt: Date | null;
  resetPasswordExpires: Date | null;
  /**
   * Monotonic kill-switch counter embedded in issued JWTs. Bumped on
   * security-relevant mutations (password reset, MFA change, OAuth unlink) so
   * that every previously-issued token whose embedded version is now stale is
   * rejected server-side on all verify paths (REST, websocket, refresh).
   */
  tokenVersion: number;

  /**
   * When true, the user must change their password before accessing the application.
   * Set when an admin creates a user with a temporary password.
   * Cleared after the user successfully sets their own password.
   * @default false
   */
  forcePasswordChangeRequired?: boolean;

  // AUP/ToS acceptance + 18+ age attestation recorded at account creation (P0-B abuse
  // gate). Top-level (not in preferences) so the legal record is server-authoritative and
  // never overwritten by a client preferences sync. Optional so legacy docs still load; the
  // grandfather migration backfills a sentinel version for pre-existing accounts.
  aupAcceptedVersion?: string | null;
  aupAcceptedAt?: Date | null;
  /** True when the user attested to being 18 or older. No DOB is collected or stored. */
  ageAttestedAdult?: boolean | null;

  // email verification
  emailVerified: boolean;
  emailVerificationToken: string | null;
  emailVerificationSentAt: Date | null;
  emailVerificationExpires: Date | null;
  /**
   * Timestamp when email was verified
   * Can distinguish between grandfathered users (cutoff date) vs actually verified users (later date)
   */
  emailVerifiedAt: Date | null;
  /**
   * Flag to prevent token reuse after successful verification
   * Set to true when token is used, prevents race condition exploits
   */
  emailVerificationUsed: boolean | null;

  // pending email change
  pendingEmail: string | null;
  pendingEmailToken: string | null;
  pendingEmailSentAt: Date | null;
  pendingEmailExpires: Date | null;
  /**
   * Flag to prevent token reuse after successful email change
   * Set to true when token is used, prevents race condition exploits
   */
  pendingEmailUsed: boolean | null;

  // Slack integration settings
  slackSettings?: {
    slackUserId?: string;
    // User access token for user-scoped APIs (e.g., reminders). Protected by select: false in DB schema.
    slackUserToken?: string;
    // OAuth scopes granted by the user (e.g., ['identity.basic', 'reminders:write'])
    slackUserScopes?: string[];
    defaultNotebookId?: string;
    autoCreateNotebook?: boolean;
    notebookNamePrefix?: string;
    lastUsedAgent?: string;
    defaultProjectId?: string; // Optional project for auto-created notebooks
    // Per-agent notebook routing (optional)
    agentNotebookRouting?: {
      dev?: string;
      pm?: string;
      analyst?: string;
      researcher?: string;
      agent?: string;
    };
    keywordRouting?: IKeywordRoutingRule[];
    customAgentId?: string; // User's custom agent for @agent command
    githubNotifications?: {
      enabled: boolean;
      githubUsername?: string;
      prOpened?: boolean;
      prReviewRequested?: boolean;
      prApproved?: boolean;
      prChangesRequested?: boolean;
      prMerged?: boolean;
      ciFailed?: boolean;
      ciPassed?: boolean;
      mentions?: boolean;
      channels?: {
        default?: string;
        ciAlerts?: string;
      };
      lastNotificationAt?: Date;
      notificationCount?: number;
    };
  };

  numReferralsAvailable: number;
  regInvites: Array<IRegInviteDocument['id']>;

  /**
   * This field is used to store the current selected organization ID.
   * But a user can be part of multiple organizations.
   */
  organizationId: IOrganizationDocument['id'] | null;
  /** This is used to store the Google Drive OAuth tokens */
  googleDrive: null | {
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
  };

  /** This is used to store the Atlassian OAuth tokens */
  atlassianConnect: null | {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    siteName: string;
    resources: Array<{
      id: string;
      name: string;
      url: string;
      scopes: string[];
      resourceType?: string;
      productType?: string;
    }>;
    connectedAt: Date;
    /**
     * Connection status:
     * - 'connected': Integration is working normally
     * - 'needs_reconnect': Refresh token expired/revoked, user needs to re-authenticate
     * - 'pending_site_selection': User has multiple Atlassian sites, waiting for selection
     */
    status?: 'connected' | 'needs_reconnect' | 'pending_site_selection';
    /** Error message when status is 'needs_reconnect' */
    disconnectReason?: string;
    /**
     * The ID of the selected Atlassian resource/site
     * Set when user completes site selection in multi-site flow
     */
    selectedResourceId?: string;
    /**
     * Expiration timestamp for pending site selection.
     * If the user doesn't complete site selection before this time,
     * the pending state can be cleared and OAuth can be re-initiated.
     * Only set when status is 'pending_site_selection'.
     */
    pendingSelectionExpiresAt?: Date;
  };

  /**
   * Notion OAuth integration
   * Note: Notion access tokens are long-lived and don't expire unless revoked.
   * There is no refresh token in the Notion OAuth flow.
   */
  notionConnect: null | {
    /** Encrypted access token from Notion OAuth */
    accessToken: string;
    /** Workspace ID from Notion */
    workspaceId: string;
    /** Workspace name for display */
    workspaceName: string;
    /** Workspace icon URL (if available) */
    workspaceIcon?: string;
    /** Bot ID associated with the integration */
    botId: string;
    /** User who authorized the integration */
    owner?: {
      type: 'user' | 'workspace';
      user?: {
        id: string;
        name?: string;
        avatarUrl?: string;
        email?: string;
      };
    };
    /** When the integration was connected */
    connectedAt: Date;
    /**
     * Connection status:
     * - 'connected': Integration is working normally
     * - 'needs_reconnect': Token was revoked or access was removed
     */
    status?: 'connected' | 'needs_reconnect';
    /** Error message when status is 'needs_reconnect' */
    disconnectReason?: string;
    /** Whether write operations (create page, append blocks) are enabled */
    writeEnabled?: boolean;
    /**
     * Root page ID that all write operations are scoped to.
     * When set, created pages default to this parent and append operations
     * are restricted to this page and its descendants.
     */
    rootPageId?: string;
    /** 'all' = full workspace access (legacy default), 'selected' = curated page list */
    accessMode?: 'all' | 'selected';
    /** Pages explicitly granted access - children inherit unless excluded */
    allowedPages?: Array<{
      id: string;
      title: string;
      type: 'page' | 'database';
      access: 'read' | 'readwrite';
    }>;
    /** Child page IDs explicitly excluded from inherited parent access */
    excludedPageIds?: string[];
  };

  /**
   * This field is used to track the last time the user was active.
   * This is set using websockets upon connection and disconnection.
   */
  lastActiveAt?: Date;
  /** Tracks if the user is online or not */
  isOnline?: boolean;

  /**
   * Array of memento references belonging to the user
   * @default []
   */
  mementos: Array<IMementoDocument['id']>;

  /**
   * User preference to display credit usage in AI replies
   * @default false
   */
  showCreditsUsed: boolean;

  /**
   * Email Integration (Email-to-Platform Ingestion)
   * Unique platform email address for ingesting emails
   * @example "consumer.smith@app.example.com"
   */
  platformEmailAddress?: string | null;

  /**
   * List of authorized email addresses that can send to the platform email address
   * Only emails from these addresses will be accepted
   * @example ["consumer.smith@gmail.com", "csmith@company.com"]
   * @default []
   */
  authorizedEmailAddresses?: string[];

  /**
   * User's preferred voice for voice sessions
   * Falls back to admin setting if not set
   * @default null
   */
  preferredVoice: string | null;

  /**
   * Per-user TTS voice override (ElevenLabs voice ID). Applied on top of the
   * org default voice agent at session start as `overrides.tts.voiceId`. When
   * unset, the agent's own configured voice is used.
   */
  voiceOverrideId?: string | null;

  /**
   * Per-user system prompt override. Applied on top of the active voice agent
   * at session start as `overrides.agent.prompt.prompt`. When unset, the
   * agent's own system prompt is used.
   */
  voiceSystemPromptOverride?: string | null;

  /**
   * User's preferred reasoning effort level for OpenAI reasoning models (O1, O3, GPT-5 series)
   * 'auto' means the system automatically classifies based on query complexity
   * Falls back to 'auto' if not set
   * @default 'auto'
   */
  preferredReasoningEffort: UserReasoningEffort | null;

  /**
   * Blog Publishing Integration
   * Stores API credentials for publishing content to external blogs
   */
  blogIntegration?: {
    apiKey: string;
    baseUrl: string; // e.g., "https://blog.example.com"
    defaultAuthor?: string;
    defaultTags?: string[];
    connectedAt?: Date;
  } | null;

  /**
   * Tracks the last manual token rotation initiation per integration.
   * Stamped when the user clicks "Re-authorize" and the OAuth URL is generated.
   * Note: this records when rotation was *initiated*, not when OAuth completed.
   */
  integrationRotation?:
    | {
        [K in RotatableIntegration]?: { lastRotationInitiatedAt: Date; lastRotationReason: string } | null;
      }
    | null;

  /**
   * User preferences synced to DB for cross-device persistence.
   * Null/undefined means no preferences have been set yet (use defaults).
   */
  preferences?: IUserPreferences | null;

  /**
   * Timestamp of the last subscription credit grant.
   * Used to enforce a 72-hour cooldown against cancel-and-resubscribe credit farming.
   */
  lastCreditGrantAt?: Date | null;
}

export interface IOAuthCredentials {
  strategy: string;
  accessToken: string;
  refreshToken: string;
}

export interface IAuthProviders {
  id: string;
  strategy: string;
  accessToken: string;
  refreshToken: string;
  // SAML-specific metadata
  samlNameId?: string;
  samlSessionIndex?: string;
  samlIdentityProviderId?: string;
  // Okta-specific metadata
  oktaIdentityProviderId?: string;
  /** Indicates if tokens are encrypted with SECRET_ENCRYPTION_KEY */
  encrypted?: boolean;
}

export interface IUserDocument extends IUser, IMongoDocument {}

export interface IUserRepository extends IBaseRepository<IUserDocument>, ICreditHolderMethods {
  findByUsernameOrEmail: (username: string, email: string) => Promise<IUserDocument | null>;
  findByEmail: (email: string) => Promise<IUserDocument | null>;
  findByEmailVerificationToken: (token: string) => Promise<IUserDocument | null>;
  findByPendingEmailToken: (token: string) => Promise<IUserDocument | null>;
  findByIdWithPassword: (id: string) => Promise<IUserDocument | null>;
  findByIdWithNotionToken: (id: string) => Promise<IUserDocument | null>;
  findByIdWithMfaSecrets: (id: string) => Promise<IUserDocument | null>;
  atomicRecordMfaFailedAttempt: (userId: string) => Promise<IUserDocument | null>;
  findAllByEmailsOrUsernames: (emails: string[], usernames: string[]) => Promise<IUserDocument[]>;
  findByStripeCustomerId: (stripeCustomerId: string) => Promise<IUserDocument | null>;
  findByIds: (
    ids: string[]
  ) => Promise<Pick<IUserDocument, 'name' | 'email' | 'username' | 'lastActiveAt' | 'isOnline' | 'photoUrl'>[]>;
  searchCollections: (
    userId: string,
    options: {
      page: number;
      limit: number;
      search: string;
      type?: CollectionType;
    },
    deps: {
      findSessionIdsByUserId: (userId: string) => Promise<string[]>;
    }
  ) => Promise<PaginatedResponse<Collection>>;
  /**
   * Increment the current storage size of a user
   * @param userId - The ID of the user
   * @param count - The amount to increment by (can be negative for decrements)
   */
  incrementCurrentStorage: (userId: string, count: number) => Promise<void>;
  /**
   * Find a user by their Slack user ID
   * Used for OAuth user linking to prevent duplicate Slack ID associations
   */
  findBySlackUserId: (slackUserId: string) => Promise<IUserDocument | null>;
  findOrCreateByEmail: (email: string, defaults: Partial<IUserDocument>) => Promise<IUserDocument>;
  /**
   * Atomically append a moderation hit and bump counters. Does not change
   * `moderation.status` - escalation is decided by the policy layer. Returns the updated user.
   */
  recordModerationHit: (userId: string, hit: IModerationHit) => Promise<IUserDocument | null>;
  /**
   * Transition a user's moderation escalation state. Mirrors `isModerated` when
   * moving to/from `suspended`. Returns the updated user.
   */
  setModerationStatus: (
    userId: string,
    status: UserModerationStatus,
    options?: { throttledUntil?: Date | null }
  ) => Promise<IUserDocument | null>;
  /**
   * Record a user's moderation appeal: stamps `moderation.appealedAt` and stores
   * the appeal text for admin review. Returns the updated user.
   */
  recordModerationAppeal: (userId: string, appealText: string) => Promise<IUserDocument | null>;
}

export type WithOrgRef<T extends IUserDocument> = T & {
  organizationId: IOrganizationDocument;
};

export interface IUserActivityCounter {
  userId: string;
  /**
   * Name of the action that the user performed
   * @todo It may be better to make this a predefined list of actions in enums
   **/
  action: string;
  count: number;
  tags: string[];
  updatedAt: Date;
}

export interface IUserActivityCounterDocument extends IUserActivityCounter, IMongoDocument {}
