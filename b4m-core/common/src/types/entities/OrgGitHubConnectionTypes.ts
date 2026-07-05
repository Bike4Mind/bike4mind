import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * GitHub connection type - either GitHub App or Service Account PAT
 */
export type GitHubConnectionType = 'github_app' | 'service_account';

/**
 * GitHub App installation target type
 */
export type GitHubInstallationTargetType = 'Organization' | 'User';

/**
 * GitHub App repository selection mode
 */
export type GitHubRepositorySelection = 'all' | 'selected';

/**
 * Organization-level GitHub API connection.
 *
 * Enables system-level GitHub API access for automation features like
 * LiveOps Triage without relying on per-user OAuth tokens.
 *
 * Supports two authentication methods:
 * - GitHub App: Preferred for production (automatic token rotation, scoped permissions)
 * - Service Account PAT: Simpler setup (Fine-grained PAT with manual rotation)
 */
export interface IOrgGitHubConnection {
  /** Organization ID this connection belongs to (null for system default) */
  organizationId: string | null;

  /** Authentication method */
  connectionType: GitHubConnectionType;

  // === GitHub App fields ===

  /** GitHub App ID */
  appId?: string;

  /** GitHub App Installation ID */
  installationId?: string;

  /** GitHub App private key (PEM format, encrypted) */
  privateKey?: string;

  /** Installation target type (Organization or User account) */
  installationTargetType?: GitHubInstallationTargetType;

  /** GitHub org/user ID where the app is installed */
  installationTargetId?: number;

  /** Repository selection mode for the installation */
  repositorySelection?: GitHubRepositorySelection;

  /** Installed permissions (e.g., { issues: 'write', contents: 'read' }) */
  permissions?: Record<string, string>;

  /** Cached installation access token (encrypted) */
  cachedAccessToken?: string;

  /** When the cached access token expires */
  tokenExpiresAt?: Date;

  /** When the token was last cached */
  tokenCachedAt?: Date;

  /** When the installation was suspended by GitHub */
  suspendedAt?: Date;

  /** Who suspended the installation ('GitHub' or user action) */
  suspendedBy?: string;

  // === Service Account PAT fields ===

  /** Fine-grained Personal Access Token (encrypted) */
  accessToken?: string;

  /** When the PAT expires (Fine-grained PATs have max 90 days) */
  patExpiresAt?: Date;

  // === Metadata ===

  /** User ID who created this connection */
  connectedBy: string;

  /** When the connection was created */
  connectedAt: Date;

  /** Repository whitelist in owner/repo format (fail-closed: empty = none allowed) */
  allowedRepositories: string[];

  /** Whether the connection is active */
  enabled: boolean;

  /** Whether this is the system default connection (for forSystem() factory) */
  isSystemDefault: boolean;

  // === Health tracking ===

  /** Last successful API call timestamp */
  lastUsedAt?: Date;

  /** Last error message */
  lastError?: string;

  /** Last API call latency in milliseconds */
  lastLatencyMs?: number;

  // === Rate limit tracking ===

  /** Remaining API requests in current window */
  rateLimitRemaining?: number;

  /** Total API requests allowed in window */
  rateLimitLimit?: number;

  /** When the rate limit resets */
  rateLimitResetAt?: Date;
}

export interface IOrgGitHubConnectionDocument extends IOrgGitHubConnection, IMongoDocument {}

/**
 * Health information for API response
 */
export interface IOrgGitHubConnectionHealth {
  lastUsedAt?: string;
  lastLatencyMs?: number;
  lastError?: string;
  rateLimitRemaining?: number;
  rateLimitLimit?: number;
  rateLimitResetAt?: string;
}

/**
 * API response type - masks sensitive credentials
 */
export interface IOrgGitHubConnectionResponse {
  id: string;
  organizationId: string | null;
  connectionType: GitHubConnectionType;

  // GitHub App (non-sensitive)
  appId?: string;
  installationId?: string;
  privateKeyMasked?: string;
  installationTargetType?: GitHubInstallationTargetType;
  installationTargetId?: number;
  repositorySelection?: GitHubRepositorySelection;
  permissions?: Record<string, string>;

  // Service Account PAT (non-sensitive)
  accessTokenMasked?: string;
  patExpiresAt?: string;

  // Metadata
  connectedBy: string;
  connectedAt: string;
  allowedRepositories: string[];
  enabled: boolean;
  isSystemDefault: boolean;

  // Health
  health: IOrgGitHubConnectionHealth;

  // Alerts
  suspendedAt?: string;

  createdAt: string;
  updatedAt: string;
}

/**
 * Request body for connecting GitHub App
 */
export interface IConnectGitHubAppRequest {
  connectionType: 'github_app';
  appId: string;
  installationId: string;
  privateKey: string;
  allowedRepositories?: string[];
}

/**
 * Request body for connecting Service Account PAT
 */
export interface IConnectGitHubPATRequest {
  connectionType: 'service_account';
  accessToken: string;
  patExpiresAt?: string;
  allowedRepositories?: string[];
}

/**
 * Union type for connection request
 */
export type IConnectGitHubRequest = IConnectGitHubAppRequest | IConnectGitHubPATRequest;

/**
 * Request body for updating connection settings
 */
export interface IUpdateGitHubConnectionRequest {
  allowedRepositories?: string[];
  enabled?: boolean;
}

/**
 * Rate limit info update
 */
export interface IRateLimitInfo {
  rateLimitRemaining: number;
  rateLimitLimit: number;
  rateLimitResetAt: Date;
}

/**
 * Health info update
 */
export interface IHealthInfo {
  lastUsedAt: Date;
  lastLatencyMs?: number;
  lastError?: string;
}

/**
 * Test connection result - uses discriminated union to prevent invalid field combinations
 * success: true requires type/login; success: false requires error
 */
export type ITestConnectionResult = ITestConnectionSuccess | ITestConnectionFailure;

export interface ITestConnectionSuccess {
  success: true;
  type: 'user' | 'app';
  login: string;
  appName?: string; // Only present when type is 'app'
  latencyMs: number;
}

export interface ITestConnectionFailure {
  success: false;
  error: string;
  latencyMs: number;
}

/**
 * Repository for managing GitHub connections.
 *
 * SECURITY NOTES:
 * - Methods ending in "WithCredentials" return encrypted sensitive fields
 *   (privateKey, accessToken, cachedAccessToken). These MUST be decrypted
 *   server-side only and NEVER included in API responses.
 * - Always use non-credential methods for UI responses
 * - Credential methods should only be called within GitHubService
 */
export interface IOrgGitHubConnectionRepository extends IBaseRepository<IOrgGitHubConnectionDocument> {
  /** Find connection by organization ID (excludes credentials) */
  findByOrganizationId(organizationId: string): Promise<IOrgGitHubConnectionDocument | null>;

  /**
   * Find connection by organization ID with credentials included.
   * SECURITY: Returns encrypted credentials. Use only within server context.
   * Never expose in API responses.
   */
  findByOrganizationIdWithCredentials(organizationId: string): Promise<IOrgGitHubConnectionDocument | null>;

  /** Find the system default connection (excludes credentials) */
  findSystemDefault(): Promise<IOrgGitHubConnectionDocument | null>;

  /**
   * Find the system default connection with credentials included.
   * SECURITY: Returns encrypted credentials. Use only within server context.
   * Never expose in API responses.
   */
  findSystemDefaultWithCredentials(): Promise<IOrgGitHubConnectionDocument | null>;

  /** Find connection by installation ID (excludes credentials) */
  findByInstallationId(installationId: string): Promise<IOrgGitHubConnectionDocument | null>;

  /**
   * Find connection by installation ID with cached token.
   * SECURITY: Returns encrypted cached token. Use only within server context.
   */
  findByInstallationIdWithCachedToken(installationId: string): Promise<IOrgGitHubConnectionDocument | null>;

  /** Update rate limit info */
  updateRateLimitInfo(id: string, info: IRateLimitInfo): Promise<IOrgGitHubConnectionDocument | null>;

  /** Update health info */
  updateHealthInfo(id: string, info: IHealthInfo): Promise<IOrgGitHubConnectionDocument | null>;

  /**
   * Update cached access token.
   * SECURITY: Token should be encrypted before calling this method.
   */
  updateCachedToken(id: string, token: string, expiresAt: Date): Promise<IOrgGitHubConnectionDocument | null>;

  /** Mark connection as suspended */
  markSuspended(id: string, suspendedBy: string): Promise<IOrgGitHubConnectionDocument | null>;

  /** Clear suspension */
  clearSuspension(id: string): Promise<IOrgGitHubConnectionDocument | null>;
}
