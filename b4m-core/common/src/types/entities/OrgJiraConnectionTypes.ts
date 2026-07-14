import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Organization-level Jira API connection.
 *
 * Enables org-scoped Jira access for automation features like LiveOps Triage,
 * replacing the system-level ATLASSIAN_* environment configuration for
 * multi-tenant deployments. Follows the same shape as IOrgGitHubConnection:
 * one connection per organization, plus an optional system default.
 *
 * Credentials use Atlassian OAuth access tokens against the Cloud API gateway
 * (https://api.atlassian.com/ex/jira/{cloudId}), matching the existing
 * getAtlassianConfig() environment-based setup.
 */
export interface IOrgJiraConnection {
  /** Organization ID this connection belongs to (null for system default) */
  organizationId: string | null;

  /** Atlassian Cloud ID for the site */
  cloudId: string;

  /** Site base URL (e.g. https://your-org.atlassian.net) */
  siteUrl: string;

  /** Atlassian access token (encrypted) */
  accessToken?: string;

  // === Metadata ===

  /** User ID who created this connection */
  connectedBy: string;

  /** When the connection was created */
  connectedAt: Date;

  /** Whether the connection is active */
  enabled: boolean;

  /** Whether this is the system default connection */
  isSystemDefault: boolean;

  // === Health tracking ===

  /** Last successful API call timestamp */
  lastUsedAt?: Date;

  /** Last error message */
  lastError?: string;
}

export interface IOrgJiraConnectionDocument extends IOrgJiraConnection, IMongoDocument {}

/**
 * API response type - masks sensitive credentials
 */
export interface IOrgJiraConnectionResponse {
  id: string;
  organizationId: string | null;
  cloudId: string;
  siteUrl: string;
  accessTokenMasked?: string;
  connectedBy: string;
  connectedAt: string;
  enabled: boolean;
  isSystemDefault: boolean;
  lastUsedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Repository for managing Jira connections.
 *
 * SECURITY NOTES:
 * - Methods ending in "WithCredentials" return the encrypted accessToken.
 *   It MUST be decrypted server-side only and NEVER included in API responses.
 */
export interface IOrgJiraConnectionRepository extends IBaseRepository<IOrgJiraConnectionDocument> {
  /** Find connection by organization ID (enabled only, excludes credentials) */
  findByOrganizationId(organizationId: string): Promise<IOrgJiraConnectionDocument | null>;

  /** Find connection by organization ID regardless of enabled status - for management queries */
  findByOrganizationIdAny(organizationId: string): Promise<IOrgJiraConnectionDocument | null>;

  /**
   * Find connection by organization ID with credentials included.
   * SECURITY: Returns encrypted credentials. Use only within server context.
   */
  findByOrganizationIdWithCredentials(organizationId: string): Promise<IOrgJiraConnectionDocument | null>;

  /** Find the system default connection (enabled only, excludes credentials) */
  findSystemDefault(): Promise<IOrgJiraConnectionDocument | null>;

  /**
   * Find the system default connection with credentials included.
   * SECURITY: Returns encrypted credentials. Use only within server context.
   */
  findSystemDefaultWithCredentials(): Promise<IOrgJiraConnectionDocument | null>;
}
