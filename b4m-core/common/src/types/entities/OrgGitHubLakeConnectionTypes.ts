import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * A single GitHub repository bound to a single org data lake through the read-only data-lake
 * GitHub App (contents:read + metadata:read, "Only select repositories").
 *
 * Deliberately separate from OrgGitHubConnection (internal issue/PR automation) and from the chat
 * MCP OAuth grant (read/write on every repo the user can reach): neither may feed a lake.
 *
 * A GitHub App has ONE installation per GitHub account, so several connections can share an
 * installationId (two lakes fed by two repos of the same org). The binding is therefore
 * (installationId, repositoryId); the installation itself is only removed with its last binding.
 */
export type GitHubLakeConnectionStatus = 'connected' | 'syncing' | 'error';

export interface IOrgGitHubLakeConnection {
  organizationId: string;
  targetDataLakeId: string;
  /** GitHub App installation id (numeric on GitHub). Shared across connections from one account. */
  installationId: number;
  /** Login of the GitHub user/org account the App is installed on. */
  accountLogin: string;
  /** GitHub's immutable numeric repository id - survives renames and transfers, unlike the name. */
  repositoryId: number;
  /** `owner/name` at connect time; display only, may go stale after a rename. */
  repositoryFullName: string;
  /** The Bike4Mind user who completed the connection. */
  connectedBy: string;
  connectedAt: Date;
  /** Model default true; archiving or deleting the lake turns it off, unarchive/restore back on. */
  enabled?: boolean;
  /** Model default 'connected'. 'error' means the App lost the repository and the user must reconnect. */
  status?: GitHubLakeConnectionStatus;
  lastError?: string | null;
  /** Re-read from GitHub on every sync; the branch can be renamed there. */
  defaultBranch?: string;
  /** The commit the last clean sync fully applied. A non-manual sync at the same HEAD is a no-op. */
  lastSyncedCommitSha?: string;
  lastSyncedAt?: Date;
  /** The latest tree read's split under GITHUB_LAKE_FILE_RULES, re-counted by every sync slice. */
  treeCandidateCount?: number;
  treeSkippedCount?: number;
  // Claim fields, same contract as IOrgGoogleDriveConnection's.
  syncClaimedAt?: Date;
  activeIngestBatchId?: string;
  ingestClaimToken?: string;
  /**
   * Set when the user disconnects (DELETE github-connection) and refreshed by every purge slice, so
   * its age is how long the queued purge has gone without progress (see GITHUB_DISCONNECT_STALL_MS).
   * While set the connection stays disabled; the row is hard-deleted once the purge finishes.
   */
  disconnectRequestedAt?: Date;
  /** When the scheduled reconcile last compared this repo's HEAD; drives its oldest-checked-first order. */
  reconcileCheckedAt?: Date;
  /** HEAD the reconcile last enqueued a sync for (null: access was lost before HEAD could be read). */
  reconcileEnqueuedSha?: string | null;
  /** When that enqueue happened; the reconcile's retry cooldown runs from here. */
  reconcileEnqueuedAt?: Date;
}

/**
 * How long a pending disconnect may go without a purge slice before a retried DELETE may enqueue a
 * fresh one. Above githubLakeRevokeQueue's 12-minute visibility timeout (infra/queues.ts), so a retry
 * never races a delivery SQS is still going to redeliver. Same window as DRIVE_DISCONNECT_STALL_MS.
 */
export const GITHUB_DISCONNECT_STALL_MS = 15 * 60 * 1000;

export function isGitHubDisconnectStalled(disconnectRequestedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - new Date(disconnectRequestedAt).getTime() >= GITHUB_DISCONNECT_STALL_MS;
}

/**
 * How a sync's tree read split under GITHUB_LAKE_FILE_RULES: files the rules admit (the sync's
 * target, before any post-fetch content check) and files they filter out. Directories are not files
 * and count as neither.
 */
export type GitHubLakeTreeCounts = { candidateCount: number; skippedCount: number };

export interface IOrgGitHubLakeConnectionDocument extends IOrgGitHubLakeConnection, IMongoDocument {}

/** API response shape for the lake manager. Credential- and claim-free. */
export interface IOrgGitHubLakeConnectionResponse {
  id: string;
  accountLogin: string;
  repositoryId: number;
  repositoryFullName: string;
  connectedBy: string;
  connectedAt: Date;
  enabled: boolean;
  status: GitHubLakeConnectionStatus;
  lastError: string | null;
  defaultBranch: string | null;
  lastSyncedAt: Date | null;
  lastSyncedCommitSha: string | null;
  /** From the latest tree read (GitHubLakeTreeCounts); null until a sync has read the tree. */
  candidateCount: number | null;
  skippedCount: number | null;
  /**
   * 'syncing' whose claim went stale (a crashed run). Nothing resets such a row on its own, but the
   * sync route admits it, so the client offers Re-sync instead of waiting on it.
   */
  syncStale: boolean;
  /** Files this connection has ingested into the lake - what a disconnect permanently deletes. */
  fileCount: number;
  /** A disconnect was accepted and its file purge is running in the background. */
  disconnecting: boolean;
  /** The pending purge has made no progress for GITHUB_DISCONNECT_STALL_MS, so a retry may re-queue it. */
  disconnectStalled: boolean;
}

/** Why an installation cannot feed a lake (lakeAppPolicy.ts findInstallationPolicyViolation). */
export type GitHubLakeInstallationPolicyViolation = 'all_repositories' | 'excess_permissions' | 'missing_contents_read';

export type GitHubLakeRepositoryChoice = {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /**
   * Null when the repository is free to connect. `dataLakeName` is null when the lake it feeds
   * belongs to another organization, whose lake names are not the caller's to see.
   */
  boundTo: { dataLakeName: string | null } | null;
};

export type GitHubLakeInstallationChoice = {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  /**
   * The installation's settings page on GitHub, where an owner changes its repository access or fixes
   * a policy violation. Owner-only: GitHub 404s it for anyone else.
   */
  settingsUrl: string;
  /**
   * GitHub's install page targeted at this account, bound to the same flow as installUrl: an owner
   * lands on this installation's repository access, any other member can request the change there.
   */
  addRepositoriesUrl: string;
  /** Set when the installation breaks the lake App policy; its repositories are then empty. */
  violation: { code: GitHubLakeInstallationPolicyViolation; message: string } | null;
  repositories: GitHubLakeRepositoryChoice[];
};

/** GET /api/data-lakes/:id/github-connection/repositories. */
export type GitHubLakeRepositoryChoicesResponse = {
  installations: GitHubLakeInstallationChoice[];
  /** The App install page, bound to the same flow so its return lands back in the picker. */
  installUrl: string;
};

export interface IOrgGitHubLakeConnectionRepository extends IBaseRepository<IOrgGitHubLakeConnectionDocument> {
  /**
   * The connection feeding a lake, deliberately GLOBAL (no org filter) so a teardown that runs after
   * the lake's org is unresolvable can still release it. SECURITY: server-side only; a route must
   * verify org access to the lake before trusting the result.
   */
  findByDataLakeIdAny(targetDataLakeId: string): Promise<IOrgGitHubLakeConnectionDocument | null>;

  /** Every connection bound through an installation, across orgs (the installation is account-wide). */
  findByInstallationId(installationId: number): Promise<IOrgGitHubLakeConnectionDocument[]>;

  /** The connections binding any of these repositories, across orgs (a repository binds at most one lake). */
  findByRepositoryIds(repositoryIds: readonly number[]): Promise<IOrgGitHubLakeConnectionDocument[]>;

  /** Hard-deletes the row so the unique repositoryId / targetDataLakeId claims are freed. */
  release(id: string, organizationId: string): Promise<boolean>;

  // Sync claim, same compare-and-set contract as IOrgGoogleDriveConnectionRepository's methods of the same names.
  // Unlike Drive's, claim/renew also refuse a disabled connection: the other half of disableIfNoLiveSyncClaim's race.
  // Adopt does not (it ingests nothing itself); it reports `enabled` so the continuation can wind the chain down.
  claimForSync(id: string): Promise<string | null>;
  adoptSyncClaim(
    id: string,
    activeIngestBatchId: string,
    claimToken: string
  ): Promise<{ token: string; enabled: boolean } | null>;
  renewSyncClaim(id: string, activeIngestBatchId: string, expectedToken: string): Promise<string | null>;
  releaseSyncClaim(
    id: string,
    expectedToken: string,
    lastError: string | null,
    status?: 'connected' | 'error'
  ): Promise<IOrgGitHubLakeConnectionDocument | null>;
  /** The clean-finish release: records the applied commit and clears lastError. */
  recordSynced(
    id: string,
    expectedToken: string,
    synced: { commitSha: string; defaultBranch: string }
  ): Promise<IOrgGitHubLakeConnectionDocument | null>;
  /**
   * Disconnect's compare-and-set: disables the connection only while no sync claim is live (the
   * isGitHubLakeSyncClaimLive notion). Reports whether the row was enabled before this call, so a caller
   * restores only what it disabled. Null means a sync is in flight (the disconnect must refuse) or no row
   * matches id + organizationId.
   */
  disableIfNoLiveSyncClaim(id: string, organizationId: string): Promise<{ wasEnabled: boolean } | null>;
  /**
   * The DELETE route's disable: disableIfNoLiveSyncClaim's compare-and-set that also (re)stamps
   * `disconnectRequestedAt`. Null means a sync is in flight (409). `created` says no disconnect was
   * pending before - only a creator may roll back via cancelDisconnect - and `previousEnabled` is what
   * that rollback restores.
   */
  markDisconnecting(
    id: string,
    organizationId: string
  ): Promise<{ stamp: Date; created: boolean; previousEnabled: boolean } | null>;
  /**
   * Undoes markDisconnecting when the purge could not be enqueued, compare-and-set on the exact
   * `stamp` so a concurrent DELETE that re-stamped since is left alone. Returns whether it matched.
   */
  cancelDisconnect(id: string, organizationId: string, stamp: Date, enabled: boolean): Promise<boolean>;
  /**
   * Stores a sync's tree counts, compare-and-set on the live claim token like renewSyncClaim, so a run
   * that lost its claim cannot overwrite the counts of the one that took it. Returns whether it matched.
   */
  recordTreeCounts(id: string, expectedToken: string, counts: GitHubLakeTreeCounts): Promise<boolean>;
  /** Refreshes a pending disconnect's stamp (each purge slice); false when none is pending. */
  touchDisconnect(id: string): Promise<boolean>;
  /**
   * Flips `enabled` on the lake's binding (lifecycle archive pause); false when the lake has none.
   * Never re-enables a binding with a pending disconnect.
   */
  setEnabledForLake(targetDataLakeId: string, enabled: boolean): Promise<boolean>;
  /** Best-effort visibility for a failure outside any sync claim (e.g. the connect-time enqueue). */
  recordLastError(id: string, lastError: string): Promise<boolean>;
  /**
   * The scheduled reconcile's batch: enabled, not disconnecting, status connected (or legacy unset) or a
   * stale 'syncing' claim, least recently checked first. 'error' is excluded - the App cannot read it.
   */
  findDueForReconcile(limit: number): Promise<IOrgGitHubLakeConnectionDocument[]>;
  /** Stamps reconcileCheckedAt without touching updatedAt. */
  markReconcileChecked(ids: readonly string[], at: Date): Promise<void>;
  /** Records the reconcile's enqueue target for its retry cooldown, without touching updatedAt. */
  markReconcileEnqueued(id: string, sha: string | null, at: Date): Promise<void>;
}
