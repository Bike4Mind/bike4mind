import { IBaseRepository, IMongoDocument } from '.';

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
}

export interface IUserApiKeyDocument extends IUserApiKey, IMongoDocument {}

export interface IUserApiKeyRepository extends IBaseRepository<IUserApiKeyDocument> {
  findByKeyPrefix: (keyPrefix: string) => Promise<IUserApiKeyDocument | null>;
  findByUserId: (userId: string) => Promise<IUserApiKeyDocument[]>;
  findByUserIdAndId: (userId: string, id: string) => Promise<IUserApiKeyDocument | null>;
  updateUsage: (id: string, usage: Partial<IUserApiKeyUsage>) => Promise<void>;
  updateLastUsed: (id: string) => Promise<void>;
  findActiveByKeyPrefix: (keyPrefix: string) => Promise<IUserApiKeyDocument | null>;
  deactivateAllByUserId: (userId: string) => Promise<void>;
  findExpiredKeys: () => Promise<IUserApiKeyDocument[]>;
  countActiveByUserId: (userId: string) => Promise<number>;
  findByProductId: (productId: string) => Promise<IUserApiKeyDocument[]>;
  /** Counts keys with status ACTIVE or RATE_LIMITED for a product. */
  countActiveByProductId: (productId: string) => Promise<number>;
}
