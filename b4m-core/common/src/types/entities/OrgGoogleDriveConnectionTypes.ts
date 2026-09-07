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

  /**
   * The data-lake batch a multi-run ingest chain is currently filling. A folder too large to ingest
   * inside one queue-Lambda invocation yields mid-loop and re-enqueues itself; this is the token that
   * lets ONLY that continuation take over the live 'syncing' claim (adoptSyncClaim), so the chain
   * keeps the connection to itself and no poll starts a competing walk that would duplicate the tail.
   * Cleared whenever a claim is taken or released. Only meaningful while status === 'syncing'.
   */
  activeIngestBatchId?: string;

  /**
   * The CAS value identifying whoever currently holds the 'syncing' claim: minted by claimForSync,
   * rotated to a fresh value on every successful adopt/renew, and cleared on every release. Each slice
   * must present the value it was issued to adoptSyncClaim or renewSyncClaim, and consuming it is what
   * makes those a real compare-and-set. `activeIngestBatchId` cannot serve as that value - it is absent
   * until a chain's first renew names a batch, and fixed for the whole chain afterwards (it also names
   * the batch document to resume) - so two deliveries of one continuation message would otherwise both
   * match it and both win. Only meaningful while status === 'syncing'.
   */
  ingestClaimToken?: string;

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
   * The connection bound to a given lake, whatever its `enabled` state, and deliberately WITHOUT an
   * org filter - the caller is the lake-purge teardown, which must release the folder claim from
   * whichever org holds it and cannot re-derive that org once the lake document is gone. A disabled
   * row still occupies the unique driveFolderId index, so `findByDataLakeId`'s enabled-only view
   * would leave exactly the strand this exists to prevent. Excludes credentials.
   * SECURITY: server-side teardown only; never hand the result to a cross-org caller.
   */
  findByDataLakeIdAny(targetDataLakeId: string): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /**
   * The connection that has claimed a given Drive folder, if any. Deliberately GLOBAL (no org
   * filter) - it answers "is this folder already claimed by ANY org", which is the whole point of
   * the global-unique index. SECURITY: server-side claim check only; the returned document (which
   * excludes the credential) must never be handed to a cross-org caller.
   */
  findByDriveFolderId(driveFolderId: string): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /**
   * Every connection whose stored credential belongs to a given user. `connectedBy` is re-stamped
   * together with the credential (see updateCredential), so it always names the credential's owner -
   * which makes this the set of connections a profile-level Google revoke breaks. Deliberately
   * CROSS-ORG for that reason; excludes credentials.
   */
  findByConnectedBy(connectedBy: string): Promise<IOrgGoogleDriveConnectionDocument[]>;

  /**
   * Enabled, healthy ('connected') connections whose last poll is due (never polled, or older than
   * the cutoff), oldest-first and capped. The re-sync poll cron's scan primitive - it enqueues each
   * onto the same ingest queue the manual Re-sync uses, so both share one delta-aware apply path.
   * Excludes 'syncing'/'credential_error'/'needs_reconnect' so a dead or in-flight connection is not
   * re-enqueued every run (claimForSync remains the ultimate per-connection race guard).
   */
  findDueForPoll(cutoff: Date, limit: number): Promise<IOrgGoogleDriveConnectionDocument[]>;

  /**
   * Load a connection WITH its encrypted credential, scoped to an org.
   * organizationId is REQUIRED so this accessor cannot hand one org's Google credential to another.
   * SECURITY: server-side only; decrypt before use; never expose in a response.
   */
  findByIdWithCredentials(id: string, organizationId: string): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /**
   * (Re)write the org-owned encrypted refresh token and re-stamp `connectedBy` to the re-syncing
   * user, scoped to an org. organizationId is REQUIRED so one org can never overwrite another org's
   * credential. Credential + connectedBy are written unconditionally; status/lastError heal to
   * `connected` only from a non-`syncing` state, so a Re-sync during an in-flight ingest cannot flip
   * the claim and start a duplicate run (see the model note). SECURITY: `encryptedRefreshToken` must
   * already be encrypted by the caller (packages/database cannot reach the crypto helpers).
   */
  updateCredential(
    id: string,
    organizationId: string,
    encryptedRefreshToken: string,
    connectedBy: string
  ): Promise<IOrgGoogleDriveConnectionDocument | null>;

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
   * would erase). Exactly one concurrent run proceeds.
   *
   * Returns the freshly-minted `ingestClaimToken` identifying this claim, or null if the claim was
   * lost. The winner must carry that token into its own renewSyncClaim, which compare-and-sets on it.
   */
  claimForSync(id: string): Promise<string | null>;

  /**
   * Continuation-only claim take-over: refreshes `syncClaimedAt` iff the connection is still 'syncing'
   * for THIS `activeIngestBatchId` AND still presents `claimToken` (the value the previous slice's
   * renewSyncClaim/adoptSyncClaim minted). A sliced ingest hands the claim from one run to the next
   * without ever passing through 'connected', so a scheduled poll cannot slip in between slices and
   * start a competing walk (which would re-create the un-uploaded tail as duplicates, the whole
   * failure this chain exists to avoid). The token match is what makes this a REAL compare-and-set: it
   * is rotated on success, so a second delivery of the same continuation message presents a token that
   * has already been consumed and loses. Returns the freshly-rotated token on success (to carry into
   * the next slice's payload), or null if the take-over lost.
   */
  adoptSyncClaim(id: string, activeIngestBatchId: string, claimToken: string): Promise<string | null>;

  /**
   * Hold the claim across a slice boundary: re-stamps `syncClaimedAt` (so the stale-claim window never
   * elapses mid-chain), records the batch the next slice must present to adopt it, and mints a fresh
   * `ingestClaimToken` for that same slice to present. Guarded on 'syncing', and a real compare-and-set
   * on `expectedToken` - the token THIS run holds, minted by its own claimForSync or rotated onto it by
   * adoptSyncClaim - so a caller that already lost the claim to a reclaim/adopt/disconnect cannot
   * re-point the connection back at a chain nobody else is running. Required for that reason: it is the
   * only field that distinguishes the holder, since the batch id is absent on a first slice and fixed
   * for the whole of a later one. Returns the minted token on success, or null.
   */
  renewSyncClaim(id: string, activeIngestBatchId: string, expectedToken: string): Promise<string | null>;

  /**
   * The one way an ingest run ends its own claim - both the failure and the success exit. Moves
   * 'syncing' -> 'connected' and stamps `lastPolledAt`, guarded so it can never clobber a terminal
   * status (e.g. credential_error) set underneath it, and compare-and-set on `expectedToken` so a run
   * that already lost the claim cannot release the NEW owner's - which would flip a live ingest back
   * to 'connected' and let a poll start a competing walk. Losing that race returns null and is not an
   * error; the new owner releases when it finishes. `lastError` is required and nullable because both
   * exits share this method: a string records the failure, null heals.
   */
  releaseSyncClaim(
    id: string,
    expectedToken: string,
    lastError: string | null
  ): Promise<IOrgGoogleDriveConnectionDocument | null>;

  /**
   * Delete a connection (org-scoped), releasing its GLOBAL Drive-folder claim so the folder can be
   * connected elsewhere. Must HARD delete: a merely-disabled row still holds the unique driveFolderId
   * index and would keep blocking re-claim. Returns true if a row was removed.
   */
  release(id: string, organizationId: string): Promise<boolean>;
}
