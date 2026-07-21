import { IBaseRepository, IMongoDocument } from '.';
import { CreditHolderType } from './CreditHolderTypes';

export enum ApiKeyScope {
  READ_NOTEBOOKS = 'notebooks:read',
  WRITE_NOTEBOOKS = 'notebooks:write',
  READ_FILES = 'files:read',
  WRITE_FILES = 'files:write',
  AI_GENERATE = 'ai:generate',
  AI_CHAT = 'ai:chat',
  READ_PROJECTS = 'projects:read',
  WRITE_PROJECTS = 'projects:write',
  /** Authorizes only the cc-bridge WS actions (cc_agent_register /
   *  cc_agent_event / cc_agent_disconnect). Keys with this scope CANNOT
   *  call chat/completions - a leaked bridge key has the narrow blast
   *  radius of a sprite-spawning credential, not a billable AI key. */
  CC_BRIDGE = 'cc-bridge:connect',
  ADMIN = 'admin:*',
  MARKETING_REPORTS_READ = 'marketing-reports:read',
  MARKETING_REPORTS_WRITE = 'marketing-reports:write',
  /** Server-to-server ingest scope for Overwatch analytics. Admin-provisioned only - never shown in user-facing key creation UI. */
  OVERWATCH_INGEST_WRITE = 'overwatch-ingest:write',
  /** Authorizes only embedded-widget chat against the single agent the key is
   *  bound to (`agentId`). Like CC_BRIDGE, a leaked embed key has a narrow blast
   *  radius: it can talk to one agent from allow-listed origins, nothing else. */
  EMBED_CHAT = 'embed:chat',
}

export enum ApiKeyStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  EXPIRED = 'expired',
  RATE_LIMITED = 'rate_limited',
}

export interface IUserApiKeyUsage {
  totalRequests: number;
  totalTokens?: number;
  lastRequest?: Date;
  requestsToday: number;
  requestsThisMinute: number;
  /**
   * Cumulative settled spend in credits, accumulated atomically per completion -
   * the counter that `spendCap` (IUserApiKey) is enforced against. Written only
   * via IUserApiKeyRepository.incrementSpend, never via updateUsage.
   */
  totalSpendCredits?: number;
}

export interface IUserApiKeyBaseline {
  // Average requests per hour (calculated from last 30 days)
  avgRequestsPerHour: number;
  // Average requests per day
  avgRequestsPerDay: number;
  // Common IP addresses (top 5 most frequent)
  commonIPs: string[];
  // Common endpoints (top 10 most frequent)
  commonEndpoints: string[];
  // Average response time in milliseconds
  avgResponseTime: number;
  // Peak usage hours (hours of day with most requests, 0-23)
  peakHours: number[];
  // Last calculated timestamp
  lastCalculatedAt: Date;
}

export interface IUserApiKeyMetadata {
  clientIP?: string;
  userAgent?: string;
  createdFrom: 'dashboard' | 'cli' | 'api' | 'bridge' | 'overwatch-admin' | 'oauth-exchange';
  /** Admin userId who minted this key. Set on insert only; service layer must reject updates. */
  createdByUserId?: string;
  /**
   * OAuth client that minted this key via the federated AI-token exchange
   * (`createdFrom === 'oauth-exchange'`). Tags the key to a (user, client) pair
   * so the exchange endpoint can find and revoke the prior key before minting a
   * fresh one - keeping at most one active exchange key per pair. NOT `productId`:
   * productId carries a global per-product active-key cap that would reject mints
   * once a client had >20 concurrent federated users.
   */
  oauthClientId?: string;
  baseline?: IUserApiKeyBaseline;
}

export interface IUserApiKeyRateLimit {
  requestsPerMinute: number;
  requestsPerDay: number;
}

/**
 * White-label config for an embed key (epic #41). Phase A stores it; the theming
 * that consumes these fields is Phase D. `hideBranding` is plan-gated there.
 */
export interface IEmbedBranding {
  primaryColor?: string;
  logoUrl?: string;
  displayName?: string;
  hideBranding?: boolean;
}

export interface IUserApiKey {
  id: string;
  userId: string;
  name: string; // Human-friendly name
  keyHash: string; // Hashed secret (never store plain text)
  keyPrefix: string; // First 16 chars for lookup (e.g., "b4m_live_xxxxxxx")
  scopes: ApiKeyScope[]; // Permissions array
  status: ApiKeyStatus;
  expiresAt?: Date; // Optional expiration
  lastUsedAt?: Date;
  rateLimit: IUserApiKeyRateLimit;
  usage: IUserApiKeyUsage;
  metadata: IUserApiKeyMetadata;
  /** Overwatch product this key is bound to. Required when scopes includes OVERWATCH_INGEST_WRITE. */
  productId?: string;
  /** Human-readable product name, stored for display in admin UI. */
  productName?: string;
  /**
   * Billing target for this key's usage. Absent/`User` = personal key billed to
   * `userId`. `Organization` = the key's AI usage debits `organizationId`'s
   * shared credit pool instead of the minting user; the minter stays in `userId`
   * for attribution + management. Invariant: `Organization` iff `organizationId`
   * is set. Only `User` and `Organization` are valid here (never `Agent`).
   */
  billingOwnerType?: ApiKeyBillingOwnerType;
  /** Organization whose credit pool this key bills. Set iff billingOwnerType is Organization. */
  organizationId?: string;
  /** Agent this embed key is bound to. Required when scopes includes EMBED_CHAT. */
  agentId?: string;
  /** https origin allow-list for an embed key (normalized, deduped, capped at EMBED_ORIGINS_MAX). */
  allowedOrigins?: string[];
  /** Optional white-label config for an embed key (see {@link IEmbedBranding}). */
  branding?: IEmbedBranding;
  /**
   * Lifetime spend ceiling for an embed key, in whole credits. Absent = uncapped.
   * A present 0 is a real cap (blocks all spend), so enforcement guards with
   * `spendCap !== undefined`, never a truthy check.
   */
  spendCap?: number;
}

/**
 * The billing owner an API key can settle usage to. A subset of
 * {@link CreditHolderType} - keys bill a person or an org, never an agent.
 */
export type ApiKeyBillingOwnerType = CreditHolderType.User | CreditHolderType.Organization;

export interface IUserApiKeyDocument extends IUserApiKey, IMongoDocument {}

export interface IUserApiKeyRepository extends IBaseRepository<IUserApiKeyDocument> {
  findByKeyPrefix: (keyPrefix: string) => Promise<IUserApiKeyDocument | null>;
  findByUserId: (userId: string) => Promise<IUserApiKeyDocument[]>;
  findByUserIdAndId: (userId: string, id: string) => Promise<IUserApiKeyDocument | null>;
  updateUsage: (id: string, usage: Partial<IUserApiKeyUsage>) => Promise<void>;
  /** Atomically adds settled credits to `usage.totalSpendCredits`. No-op for non-finite or <= 0 amounts. */
  incrementSpend: (id: string, credits: number) => Promise<void>;
  /** Sets the spend ceiling; `null` clears it ($unset), so the key becomes uncapped. */
  setSpendCap: (id: string, spendCap: number | null) => Promise<void>;
  /** Zeroes `usage.totalSpendCredits` - the top-up lever for an over-cap key. */
  resetSpend: (id: string) => Promise<void>;
  updateLastUsed: (id: string) => Promise<void>;
  findActiveByKeyPrefix: (keyPrefix: string) => Promise<IUserApiKeyDocument | null>;
  deactivateAllByUserId: (userId: string) => Promise<void>;
  findExpiredKeys: () => Promise<IUserApiKeyDocument[]>;
  countActiveByUserId: (userId: string) => Promise<number>;
  findByProductId: (productId: string) => Promise<IUserApiKeyDocument[]>;
  /** Counts keys with status ACTIVE or RATE_LIMITED for a product. */
  countActiveByProductId: (productId: string) => Promise<number>;
  /** All keys billed to an organization's credit pool (any status), newest first. */
  findByOrganizationId: (organizationId: string) => Promise<IUserApiKeyDocument[]>;
  /** Active keys bound to an agent (embed keys), newest first; uses the sparse
   *  { agentId, status } index. */
  findByAgentId: (agentId: string) => Promise<IUserApiKeyDocument[]>;
}
