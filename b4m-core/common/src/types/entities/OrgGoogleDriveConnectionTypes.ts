import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Auth method for an org-level Google Drive connection.
 * v1 implements only 'oauth' (an org admin connects a Google account); 'service_account'
 * is a reserved, deferred cloud-only mode. See the #1587 auth-model resolution.
 */
export type GoogleDriveConnectionAuthMode = 'oauth' | 'service_account';

/**
 * Health/lifecycle state of the connection.
 * - connected: idle, healthy
 * - syncing: an ingest is in flight; a guarded per-connection claim so two concurrent runs
 *   (a double-clicked connect, a retried request) can't both walk and duplicate every file
 * - needs_reconnect: the folder is no longer reachable (un-shared / trashed: 403/404 on the folder)
 * - credential_error: the stored credential failed (e.g. invalid_grant) - operator/admin attention
 */
export type GoogleDriveConnectionStatus = 'connected' | 'syncing' | 'needs_reconnect' | 'credential_error';

/**
 * Organization-level Google Drive connection: binds a single Drive folder to a single
 * data lake so the folder's contents are ingested and kept in sync.
 *
 * Unlike the per-user `User.googleDrive`, the credential is org-owned and lives here, so a
 * reconnect is an explicit admin action rather than a silent outage when the connecting
 * user churns. Follows the org-connection pattern of IOrgGitHubConnection / IOrgJiraConnection
 * (org-scoped collection, secret excluded from default reads, encrypted at rest).
 *
 * An org may hold MANY connections (one per folder/lake). A given Drive folder is claimable by
 * at most one org, ever (global uniqueness on driveFolderId), and a lake is fed by at most one
 * folder (v1). See OrgGoogleDriveConnectionModel for the indexes that enforce this.
 */
export interface IOrgGoogleDriveConnection {
  /** Organization that owns this connection (required - no system-default row). */
  organizationId: string;

  /** Authentication method (v1: 'oauth'). */
  authMode: GoogleDriveConnectionAuthMode;

  /** Google Drive folder id being ingested. Globally unique across all orgs. */
  driveFolderId: string;

  /** Human-readable folder name (for admin UI; not authoritative). */
  folderName?: string;

  /** The data lake this folder feeds (FK -> DataLake). */
  targetDataLakeId: string;

  /**
   * OAuth refresh token for the org-owned Google connection, ENCRYPTED at rest.
   * SECURITY: `select: false` in the schema; only ever read via findByIdWithCredentials
   * and decrypted server-side. Never include in an API response.
   */
  oauthRefreshToken?: string;

  // === Metadata ===

  /** User id who created the connection. */
  connectedBy: string;

  /** When the connection was created. */
  connectedAt: Date;

  /** Whether the connection is active (operational disable switch; accessors split on this). */
  enabled: boolean;

  // === Health tracking ===

  /** Current health state. */
  status: GoogleDriveConnectionStatus;

  /** Last error message (payload for status !== 'connected'; cleared on a healthy update). */
  lastError?: string;

  /** Last successful Drive API call. */
  lastUsedAt?: Date;

  /** Last time the folder was polled for changes. */
  lastPolledAt?: Date;

  /**
   * When the current 'syncing' claim was taken. Lets a STALE claim - left by an ingest process that
   * died past the queue's Lambda timeout without releasing - be reclaimed, instead of wedging the
   * connection in 'syncing' forever. Only meaningful while status === 'syncing'.
   */
  syncClaimedAt?: Date;

  // === Incremental sync ===

  /**
   * Drive changes pageToken - the durable cross-run resumption point for re-sync.
   * Advisory only: the changes feed is not guaranteed-complete for shared items, so re-sync
   * also reconciles by modifiedTime. Advance only after a sync batch is durably created.
   */
  syncCursor?: string;
}

export interface IOrgGoogleDriveConnectionDocument extends IOrgGoogleDriveConnection, IMongoDocument {}

/**
 * API response shape - never exposes the refresh token.
 */
export interface IOrgGoogleDriveConnectionResponse {
  id: string;
  organizationId: string;
  authMode: GoogleDriveConnectionAuthMode;
  driveFolderId: string;
  folderName?: string;
  targetDataLakeId: string;
  /** Whether a stored credential exists (never the token itself). */
  hasCredentials: boolean;
  connectedBy: string;
  connectedAt: string;
  enabled: boolean;
  status: GoogleDriveConnectionStatus;
  lastError?: string;
  lastUsedAt?: string;
  lastPolledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Request body to connect a Drive folder to a lake. The credential is captured server-side via OAuth, not in this body. */
export interface IConnectGoogleDriveRequest {
  driveFolderId: string;
  folderName?: string;
  targetDataLakeId: string;
}

/** Request body to update connection settings. */
export interface IUpdateGoogleDriveConnectionRequest {
  enabled?: boolean;
  folderName?: string;
}

/** Health-update payload. Omit `lastError` (or pass undefined) to clear it on a healthy update. */
export interface IGoogleDriveConnectionHealthUpdate {
  status: GoogleDriveConnectionStatus;
  lastError?: string;
  lastUsedAt?: Date;
  lastPolledAt?: Date;
}

/**
 * Repository for org-level Google Drive connections.
 *
 * SECURITY: `findByIdWithCredentials` returns the encrypted `oauthRefreshToken`. It must be
 * decrypted server-side only (via the app's tokenEncryption helper) and NEVER included in an
 * API response. All other accessors exclude the credential by default (`select: false`).
 */
export interface IOrgGoogleDriveConnectionRepository extends IBaseRepository<IOrgGoogleDriveConnectionDocument> {
  /** All enabled connections for an org (excludes credentials). */
  findByOrganizationId(organizationId: string): Promise<IOrgGoogleDriveConnectionDocument[]>;

  /** All connections for an org regardless of enabled status (admin/management views). */
  findByOrganizationIdAny(organizationId: string): Promise<IOrgGoogleDriveConnectionDocument[]>;

  /**
   * The enabled connection feeding a given lake in a given org, if any (excludes credentials).
   * organizationId is REQUIRED so a missing tenant scope is a compile error, not a review catch.
   */
  findByDataLakeId(targetDataLakeId: string, organizationId: string): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /**
   * The connection that has claimed a given Drive folder, if any. Deliberately GLOBAL (no org
   * filter) - it answers "is this folder already claimed by ANY org", which is the whole point of
   * the global-unique index. SECURITY: server-side claim check only; the returned document (which
   * excludes the credential) must never be handed to a cross-org caller.
   */
  findByDriveFolderId(driveFolderId: string): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /**
   * Load a connection WITH its encrypted credential, scoped to an org.
   * organizationId is REQUIRED so this accessor cannot hand one org's Google credential to another.
   * SECURITY: server-side only; decrypt before use; never expose in a response.
   */
  findByIdWithCredentials(id: string, organizationId: string): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /** Update health state; clears `lastError` on a healthy update. */
  updateHealth(
    id: string,
    update: IGoogleDriveConnectionHealthUpdate
  ): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /** Advance the incremental-sync cursor after a sync batch is durably created. */
  updateSyncCursor(id: string, syncCursor: string, polledAt: Date): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /**
   * Guarded per-connection ingest lock. Atomically flips `status` to 'syncing' (stamping
   * `syncClaimedAt`) iff the connection is idle ('connected') OR its existing 'syncing' claim is
   * STALE (older than the Lambda timeout) - so a process that died mid-sync can't wedge it forever,
   * and a claim never lands OVER a credential_error/needs_reconnect state (which a later release
   * would erase). Returns whether THIS caller won the claim; exactly one concurrent run proceeds.
   */
  claimForSync(id: string): Promise<boolean>;

  /**
   * Release a 'syncing' claim on a failure path, guarded so it only moves 'syncing' -> 'connected'
   * and can never clobber a terminal status (e.g. credential_error) set underneath it. The success
   * path releases via `updateHealth({ status: 'connected' })` instead.
   */
  releaseSyncClaim(id: string): Promise<IOrgGoogleDriveConnectionDocument | null>;
}
