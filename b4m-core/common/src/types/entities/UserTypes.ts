import { IBaseRepository, IMongoDocument } from '.';
import { ISessionDocument } from './SessionTypes';
import { IRegInviteDocument } from './RegistrationInviteType';
import { IOrganizationDocument } from './OrganizationTypes';
import { ICounters } from './CounterTypes';
import { IMementoDocument } from './MementoTypes';
import { ICreditHolder, ICreditHolderMethods } from './CreditHolderTypes';
import { PaginatedResponse, UserReasoningEffort } from '../common';
import type { AuthStrategy } from '../../schemas/user';
import type { SignupRiskSignal } from '../../schemas/settings';
import type { SignupGrant, SignupGrantAssessment } from '../../signupGrant';
import type { AdminPermissionId } from '../../adminPermissions';

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

/**
 * Network facts about the request that created or signed in to an account, read server-side
 * (apps/client server/auth/networkMeta.ts). Every field is null when unknown: a failed or missing
 * lookup never blocks auth.
 */
export interface INetworkMeta {
  ip: string | null;
  userAgent: string | null;
  asn: number | null;
  /** Operator name, known only for ASNs on the bundled hosting-provider list. */
  asnOrg: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  /** Whether the ASN is a hosting/datacenter network; null when the ASN is unknown. */
  isDatacenter: boolean | null;
  ja4?: string | null;
  /**
   * WAF anonymous-IP label matched; null on self-host and when ORIGIN_VERIFY_SECRET is absent (no WAF attached).
   * Only set to true on /api/otc/ paths -- the AnonymousIpList rule is scoped there;
   * false on other deployed paths means unchecked, not "not anonymous".
   */
  wafAnonIp?: boolean | null;
  /** WAF bot-control bot label matched; null on self-host and when ORIGIN_VERIFY_SECRET is absent (no WAF attached). */
  wafBotSignal?: boolean | null;
}

export interface ISignupMeta extends INetworkMeta {
  capturedAt: Date;
}

/**
 * none and pending follow the score on every recompute; approved and banned are an admin's ruling
 * and a recompute never changes them.
 */
export const SIGNUP_RISK_REVIEW_STATES = ['none', 'pending', 'approved', 'banned'] as const;
export type SignupRiskReviewState = (typeof SIGNUP_RISK_REVIEW_STATES)[number];

export interface ISignupRiskScore {
  /** 0-100, from scoreSignupRisk (b4m-core/services/src/userService/signupRiskScore.ts). */
  score: number;
  signals: { signal: SignupRiskSignal; points: number; reason: string }[];
  computedAt: Date;
  reviewState: SignupRiskReviewState;
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
  /**
   * Plaintext backup codes (comma-joined) for a setup not yet verified, so a repeat setup call
   * can re-serve the codes the user already saved. Encrypted at rest; cleared on enable.
   */
  pendingBackupCodes?: string;
  // Server-side attempt tracking (can't be bypassed by refresh/cancel)
  failedAttempts?: number;
  lastFailedAttempt?: Date;
  lockedUntil?: Date;
}

/**
 * A WebAuthn credential (passkey) enrolled as an additional MFA method. Lives in its own
 * collection rather than on `IMFAConfig`: the user model's guard strips any `mfa` write that
 * lacks the select:false `totpSecret`, which a credential write would routinely trip.
 * Binary fields are base64url-encoded.
 */
export interface IPasskeyCredential {
  id: string;
  userId: string;
  credentialId: string;
  /** COSE-encoded public key. */
  publicKey: string;
  /** Authenticator signature counter; a regression on use signals a cloned authenticator. */
  counter: number;
  transports?: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  name: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

export type PasskeyChallengePurpose = 'registration' | 'authentication';

export interface IPasskeyCredentialRepository {
  create(input: Omit<IPasskeyCredential, 'id' | 'createdAt' | 'lastUsedAt'>): Promise<IPasskeyCredential>;
  listByUser(userId: string): Promise<IPasskeyCredential[]>;
  countByUser(userId: string): Promise<number>;
  findByCredentialId(userId: string, credentialId: string): Promise<IPasskeyCredential | null>;
  recordUse(id: string, counter: number): Promise<void>;
  /** Returns true when a credential was actually removed (false = unknown id or not this user's). */
  remove(id: string, userId: string): Promise<boolean>;
  removeAllForUser(userId: string): Promise<number>;
}

/**
 * Server-held WebAuthn challenges. One live challenge per user + purpose; `consume` returns it
 * at most once, so a captured ceremony response cannot be replayed.
 */
export interface IPasskeyChallengeRepository {
  issue(userId: string, purpose: PasskeyChallengePurpose, challenge: string): Promise<void>;
  consume(userId: string, purpose: PasskeyChallengePurpose): Promise<string | null>;
}

/**
 * User preferences that are synced to the database for cross-device persistence.
 * All fields are optional - missing/null means "use default".
 */
export interface IUserPreferences {
  language?: string;
  favoriteTags?: string[];
  favoriteModelIds?: string[];
  /** Workspace surface ids the user hid from their own UI; display only, access is unchanged (see surfaces.ts). */
  hiddenSurfaces?: string[];
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
  /** Whether to show fun/novelty tools (chess, dice, ISS tracker, etc.) in the tools catalog. Default: false. */
  showFunTools?: boolean;
  /** Whether to show the prompt suggestion cards on the splash screen. Default: false. */
  showSplashCards?: boolean;
  /** Set once the user closes the "Try the desktop app" pill in the sidebar; it never shows again. */
  desktopPromoDismissed?: boolean;
}

/**
 * Which system produced a moderation hit.
 * - 'openai': OpenAI Moderation API pre-send check.
 * - 'bedrock': Bedrock Guardrails pre-send check.
 * - 'provider': provider-side block (settled refusal/content_filter stop reason or a
 *   classifier throw that no fallback model answered); no pre-call moderation service was involved and
 *   no category labels are available from the provider.
 */
export type ModerationHitSource = 'openai' | 'bedrock' | 'provider';

/**
 * Escalation state for a user's moderation record.
 * - `active`: no action; normal usage.
 * - `throttled`: auto-applied on repeat hits; a tighter rate limit is enforced until `throttledUntil`.
 * - `suspend_pending`: threshold for suspension reached - flagged for a human to confirm. NOT auto-blocking.
 * - `suspended`: human-confirmed suspension; the account is blocked at sign-in.
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
  /**
   * Whether `password` is a real, user-known credential usable for authentication
   * (password-based login via emergency-login). NOT inferable from `password`
   * truthiness - admin/migration "shell" accounts store an auto-generated, unusable
   * password that is bcrypt-hashed and therefore indistinguishable from a real one.
   * Passwordless-first: each creation site sets this explicitly. Gates the SSO
   * auto-link local-email-verified requirement - see verifyCallback.ts / okta/callback.ts.
   * @default false
   */
  hasUsablePassword?: boolean;
  groups: Array<string> | null;
  isAdmin: boolean;
  adminPermissions?: AdminPermissionId[];
  storageLimit: number /** Effective storage limit in decimal MB */;
  /** Manual or custom signup allocation; null means use plan/default. */
  storageLimitOverride?: number | null;
  /** Plan allocation in decimal MB, separate from the manual override. */
  planStorageLimit?: number | null;
  currentStorageSize: number /** Current storage size in Bytes */;
  tags: Array<string> | null;
  /**
   * Invite-resolved credit amount awaiting proof of email ownership. Set at
   * registration alongside PENDING_FREE_CREDITS_TAG; released (and nulled) by
   * userService.releasePendingFreeCredits on OTC registration, email-link verify, first
   * OTC login, OAuth signup/link, or the backfillPendingFreeCredits script. Null when
   * nothing is pending - the open-registration path leaves it null and grants
   * `defaultFreeCredits` instead.
   */
  pendingCreditGrant?: number | null;
  /**
   * Canonical inbox (canonicalizeEmail) this account claimed its free-credit grant under. Unset
   * until a grant is claimed; unique across users, so aliases of one inbox share a single grant.
   */
  freeCreditClaimEmail?: string | null;
  /** Absent on accounts created before staged grants were enabled. */
  signupGrant?: SignupGrant;
  signupGrantAssessment?: SignupGrantAssessment;
  level: UserLevelType;
  isBanned: boolean;
  isModerated: boolean;
  /** Admin override that trusts the account for personal API keys (userApiKeyService/trust.ts). Absent on legacy docs. */
  apiKeyTrustApproved?: boolean;
  /**
   * Per-user moderation tracking + auto-throttle/suspend state.
   * Absent until the user's first moderation hit. Independent of `isModerated`, the admin's
   * AI-only block.
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
   * Last accepted TOTP time step; a code at or below it is a replay. Kept outside `mfa` because
   * MFA success writes replace that subdocument whole and would roll a concurrent claim back.
   */
  totpLastStep?: number | null;

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
    slackTeamId?: string;
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
  /** Sender of the referral invite this account redeemed; unset for accounts that signed up without one. */
  referredByUserId?: string | null;

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

  /** Single-use nonce for Notion OAuth; set at connect, consumed at callback. */
  pendingNotionOAuthNonce?: string | null;

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

  /**
   * Campaign touches the browser carried at signup, written once and only with attribution consent
   * (apps/client server/analytics/funnel.ts). Absent when there was no consented touch.
   */
  acquisition?: IUserAcquisition | null;

  /** Network metadata of the signup request, written once at account creation. Admin-only PII. */
  signupMeta?: ISignupMeta | null;

  /** Abuse risk of a new account. Never shown to the user: the signals would say how to avoid them. */
  riskScore?: ISignupRiskScore | null;

  /**
   * A test persona or test-domain account, decided at signup. Funnel analytics skip or tag these so
   * synthetic traffic never reaches conversion metrics.
   */
  isSynthetic?: boolean;

  /** When the user first got a completed chat answer; set once, drives the first_value event. */
  firstValueAt?: Date | null;
}

export interface IUserAcquisitionTouch {
  source: string;
  medium?: string;
  campaign?: string;
  content?: string;
}

export interface IUserAcquisition {
  firstTouch?: IUserAcquisitionTouch;
  lastTouch?: IUserAcquisitionTouch;
  /** How the account was created (`otc`, `google`, `github`, ...). */
  signupMethod: string;
  capturedAt: Date;
}

export interface IOAuthCredentials {
  strategy: string;
  accessToken: string;
  refreshToken: string;
}

export interface IAuthProviders {
  /** Provider subject/user id. Nullable: legacy rows pre-date schema validation and may carry null. */
  id: string | null;
  strategy: AuthStrategy;
  accessToken?: string;
  refreshToken?: string;
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
  findByUsernameOrEmail: (username: string, email?: string | null) => Promise<IUserDocument | null>;
  findByEmail: (email: string) => Promise<IUserDocument | null>;
  /**
   * Whether any user other than `excludeUserId` holds `email`, compared trimmed and
   * case-insensitively. Engine-portable (MongoDB and DocumentDB), unlike the collation lookups.
   */
  existsOtherUserWithEmail: (email: string, excludeUserId?: string) => Promise<boolean>;
  /** Username counterpart of {@link IUserRepository.existsOtherUserWithEmail}. */
  existsOtherUserWithUsername: (username: string, excludeUserId?: string) => Promise<boolean>;
  /**
   * Whether a live, unbanned, non-system user whose email is on `domain` or a subdomain of it
   * verified that email no later than `verifiedBefore`. An unindexed suffix scan: call it rarely and cache the answer.
   */
  existsVerifiedUserOnEmailDomain: (domain: string, verifiedBefore: Date) => Promise<boolean>;
  /**
   * Remove the given group ids from EVERY user's `groups[]` (org-wide blast radius; used when a
   * group type is revoked and its instances are soft-deleted). Named for the scope so a caller
   * cannot mistake it for a single-user operation.
   */
  removeGroupsFromAllUsers: (groupIds: string[]) => Promise<void>;
  /** Null `organizationId` on EVERY user pointing at the org (used when the org is deleted). */
  clearOrganizationPointer: (organizationId: string) => Promise<void>;
  /** Add a single group id to one user's `groups[]` (idempotent; used when assigning a member). */
  addGroupToUser: (userId: string, groupId: string) => Promise<void>;
  /** Merge tags into one user's `tags[]` (idempotent, no duplicates; used by partner signup rules). */
  addTagsToUser: (userId: string, tags: string[]) => Promise<void>;
  /** Remove the given file ids from the named users' `systemFiles[]` (idempotent $pull, enabled or not). */
  pullSystemFilesForUsers: (userIds: string[], fileIds: string[]) => Promise<void>;
  /** Remove a single group id from one user's `groups[]` (used when unassigning a member). */
  removeGroupFromUser: (userId: string, groupId: string) => Promise<void>;
  /**
   * Charge `count` referrals (floored at zero) and add the invites they created to `regInvites`.
   * @deprecated Reservations are not atomic and can overspend under concurrency. Use
   * `reserveReferrals` before side effects and `settleReferrals` afterward.
   */
  recordReferrals: (userId: string, count: number, newInviteIds: string[]) => Promise<void>;
  /** Atomically charge `count` referrals; resolves false when the allowance is below `count`. */
  reserveReferrals: (userId: string, count: number) => Promise<boolean>;
  /** Refund `refundCount` failed referrals and add `newInviteIds` to `regInvites`; not idempotent, do not retry. */
  settleReferrals: (userId: string, refundCount: number, newInviteIds: string[]) => Promise<void>;
  /**
   * Remove several group ids from ONE user's `groups[]` (idempotent $pull). Used when a member
   * leaves or is removed from an org, to strip that org's group ids from just that member.
   */
  removeGroupsFromUser: (userId: string, groupIds: string[]) => Promise<void>;
  /**
   * Member ids per group id in a single aggregation (keyed by group id, absent = no members).
   * Used by the group-list route - one pass instead of an N+1 of per-group reads. The management
   * UI needs the ids (to render + unassign members), and memberCount is derived from them.
   */
  findUserIdsByGroupIds: (groupIds: string[]) => Promise<Record<string, string[]>>;
  findByEmailVerificationToken: (token: string) => Promise<IUserDocument | null>;
  findByPendingEmailToken: (token: string) => Promise<IUserDocument | null>;
  findByIdWithPassword: (id: string) => Promise<IUserDocument | null>;
  findByIdWithNotionToken: (id: string) => Promise<IUserDocument | null>;
  findByIdWithMfaSecrets: (id: string) => Promise<IUserDocument | null>;
  atomicRecordMfaFailedAttempt: (userId: string) => Promise<IUserDocument | null>;
  atomicReserveMfaAttempt: (userId: string) => Promise<{ reserved: boolean; user: IUserDocument | null }>;
  atomicClaimTotpStep: (userId: string, step: number) => Promise<boolean>;
  atomicConsumeBackupCode: (userId: string, codeHash: string) => Promise<boolean>;
  /**
   * Claim the one free-credit grant allowed per inbox. True when this account holds the claim
   * (now or from an earlier attempt), false when another account already does.
   */
  claimFreeCreditGrant: (userId: string) => Promise<boolean>;
  /**
   * Enable MFA only while the stored secret is still `totpSecret` and MFA is still disabled.
   * Returns null when a concurrent setup replaced the secret, so a code verified against a
   * superseded secret never enables a secret the user's authenticator does not hold.
   */
  atomicEnableMfa: (userId: string, totpSecret: string) => Promise<IUserDocument | null>;
  findAllByEmailsOrUsernames: (emails: string[], usernames: string[]) => Promise<IUserDocument[]>;
  findByStripeCustomerId: (stripeCustomerId: string) => Promise<IUserDocument | null>;
  // `id` is included so callers can map results back to the requested ids (Mongoose adds the
  // id virtual regardless of the projection); other consumers already rely on it at runtime.
  findByIds: (
    ids: string[]
  ) => Promise<Pick<IUserDocument, 'id' | 'name' | 'email' | 'username' | 'lastActiveAt' | 'isOnline' | 'photoUrl'>[]>;
  /** Active (non-soft-deleted), emailed users among `ids` - for a notification addressee resolver. */
  findActiveEmailsByIds: (ids: string[]) => Promise<Array<{ id: string; email: string }>>;
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
   * Compare-and-set `currentStorageSize`: writes `next` only while the stored counter still equals
   * `expected` (a missing counter counts as 0). Returns false when a concurrent charge or refund moved
   * it, so a recalculated absolute value never overwrites an adjustment it did not see.
   */
  setCurrentStorageIfUnchanged: (userId: string, expected: number, next: number) => Promise<boolean>;
  /** The user's `currentStorageSize` (missing counts as 0), or null when the user does not exist. */
  findCurrentStorageSize: (userId: string) => Promise<number | null>;
  /** One keyset page of user ids in `_id` order, starting after `afterId` (null = first page). */
  listUserIdsAfter: (afterId: string | null, limit: number) => Promise<string[]>;
  /**
   * Atomically bump the user's tokenVersion - the server-side session kill switch.
   * Every currently-issued access/refresh token for the user carries the old version and
   * is rejected on its next request (per-request check in auth.ts, and at WS connect).
   * Returns the new tokenVersion. Throws NotFoundError if the user no longer exists,
   * rather than silently reporting a successful revoke that never happened.
   */
  incrementTokenVersion: (userId: string) => Promise<number>;
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
   * Transition a user's moderation escalation state. Leaves `isModerated` alone. Returns the
   * updated user.
   */
  setModerationStatus: (
    userId: string,
    status: UserModerationStatus,
    options?: { throttledUntil?: Date | null }
  ) => Promise<IUserDocument | null>;
  /**
   * Store a recomputed risk score. `riskScore.reviewState` is only the proposal: an approved or
   * banned state already stored is kept, in the same write, so an admin ruling made since the
   * caller read the user is never undone.
   */
  setRiskScore: (userId: string, riskScore: ISignupRiskScore) => Promise<void>;
  /**
   * Ids of users created at or after `since` whose risk review is not settled (approved or banned),
   * in id order; pass the last id back as `afterId` for the next page.
   */
  findRiskScoringCandidateIds: (since: Date, options: { afterId?: string; limit: number }) => Promise<string[]>;
  /** Unbanned users whose risk review is pending, highest score first, at most `limit`. */
  findPendingRiskReviews: (limit: number) => Promise<IUserDocument[]>;
  /**
   * Move a user's review from `from` to `to`, only if it is still `from`; false when it was not
   * (already decided, rescored out of pending, or no score). Used for admin approve and its undo.
   */
  setRiskReviewState: (userId: string, from: SignupRiskReviewState, to: SignupRiskReviewState) => Promise<boolean>;
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
