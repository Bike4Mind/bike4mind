import {
  IOrgGitHubLakeConnection,
  IOrgGitHubLakeConnectionDocument,
  IOrgGitHubLakeConnectionRepository,
  IMongoDocument,
  GITHUB_DISCONNECT_STALL_MS,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { releaseLakeClaimBestEffort } from './LakeConnectorClaimModel';
import { randomUUID } from 'crypto';
import { redactLastError } from './OrgGoogleDriveConnectionModel';

// Same windows as OrgGoogleDriveConnection: an unchained claim is one invocation (10 min Lambda); a chained
// one is refreshed only at slice boundaries, so its un-refreshed interval includes a queue wait of up to 15 min.
const SYNC_CLAIM_STALE_MS = 20 * 60 * 1000;
const CHAINED_SYNC_CLAIM_STALE_MS = 60 * 60 * 1000;

export function isGitHubLakeSyncClaimLive(
  conn: Pick<IOrgGitHubLakeConnection, 'status' | 'syncClaimedAt' | 'activeIngestBatchId'>,
  nowMs: number = Date.now()
): boolean {
  if (conn.status !== 'syncing' || !conn.syncClaimedAt) return false;
  const staleMs = conn.activeIngestBatchId ? CHAINED_SYNC_CLAIM_STALE_MS : SYNC_CLAIM_STALE_MS;
  return nowMs - new Date(conn.syncClaimedAt).getTime() < staleMs;
}

// isGitHubLakeSyncClaimLive's staleness windows as Mongo clauses; the two must stay in sync.
function staleSyncClaimClauses() {
  const now = Date.now();
  return [
    { activeIngestBatchId: { $in: [null] }, syncClaimedAt: { $lt: new Date(now - SYNC_CLAIM_STALE_MS) } },
    { activeIngestBatchId: { $ne: null }, syncClaimedAt: { $lt: new Date(now - CHAINED_SYNC_CLAIM_STALE_MS) } },
  ];
}

// The negation of isGitHubLakeSyncClaimLive, as one atomic match so a claimForSync cannot land in between.
function noLiveSyncClaimFilter(id: string, organizationId: string) {
  return {
    _id: id,
    organizationId,
    $or: [{ status: { $ne: 'syncing' } }, { syncClaimedAt: { $in: [null] } }, ...staleSyncClaimClauses()],
  };
}

// Once disableIfNoLiveSyncClaim wins, a queued message must not start or extend an ingest past the purge.
const NOT_DISABLED = { enabled: { $ne: false } };

/**
 * One GitHub repository -> one org data lake, through the read-only data-lake GitHub App. See
 * IOrgGitHubLakeConnection for why this is not OrgGitHubConnection and why installationId repeats.
 * No credential is stored: the App mints short-lived installation tokens from its private key.
 */
const OrgGitHubLakeConnectionSchema = new Schema<IOrgGitHubLakeConnectionDocument>(
  {
    organizationId: { type: String, required: true },
    targetDataLakeId: { type: String, required: true },
    installationId: { type: Number, required: true },
    accountLogin: { type: String, required: true, trim: true },
    repositoryId: { type: Number, required: true },
    repositoryFullName: { type: String, required: true, trim: true },
    connectedBy: { type: String, required: true },
    connectedAt: { type: Date, required: true },
    enabled: { type: Boolean, default: true },
    status: { type: String, enum: ['connected', 'syncing', 'error'], default: 'connected' },
    lastError: { type: String },
    defaultBranch: { type: String },
    lastSyncedCommitSha: { type: String },
    lastSyncedAt: { type: Date },
    syncClaimedAt: { type: Date },
    activeIngestBatchId: { type: String },
    ingestClaimToken: { type: String },
    disconnectRequestedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One lake per repository, globally. The index is only the claim; the proof that the claimant may
// bind the repo (the installer can see it through their own GitHub user token) runs before the insert
// in completeGitHubLakeConnection.
OrgGitHubLakeConnectionSchema.index({ repositoryId: 1 }, { unique: true, name: 'org_gh_lake_conn_repo_id' });

// One repository per lake (v1, matching the Drive source).
OrgGitHubLakeConnectionSchema.index({ targetDataLakeId: 1 }, { unique: true, name: 'org_gh_lake_conn_lake_id' });

// Bindings sharing an installation: picking the unbound repo on connect, and deciding on disconnect
// whether the installation still has other bindings.
OrgGitHubLakeConnectionSchema.index({ installationId: 1 }, { name: 'org_gh_lake_conn_installation_id' });

OrgGitHubLakeConnectionSchema.index({ organizationId: 1 }, { name: 'org_gh_lake_conn_org_id' });

export interface IOrgGitHubLakeConnectionModel extends Model<IOrgGitHubLakeConnectionDocument & IMongoDocument> {}

export const OrgGitHubLakeConnection: IOrgGitHubLakeConnectionModel =
  mongoose.models.OrgGitHubLakeConnection ??
  model<IOrgGitHubLakeConnectionDocument>('OrgGitHubLakeConnection', OrgGitHubLakeConnectionSchema);

class OrgGitHubLakeConnectionRepository
  extends BaseRepository<IOrgGitHubLakeConnectionDocument & IMongoDocument>
  implements IOrgGitHubLakeConnectionRepository
{
  async findByDataLakeIdAny(
    targetDataLakeId: string
  ): Promise<(IOrgGitHubLakeConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ targetDataLakeId });
  }

  async findByInstallationId(installationId: number): Promise<(IOrgGitHubLakeConnectionDocument & IMongoDocument)[]> {
    return this.find({ installationId });
  }

  async findByRepositoryIds(
    repositoryIds: readonly number[]
  ): Promise<(IOrgGitHubLakeConnectionDocument & IMongoDocument)[]> {
    if (repositoryIds.length === 0) return [];
    return this.find({ repositoryId: { $in: [...repositoryIds] } });
  }

  /** Hard delete: a soft-deleted row would keep the unique repositoryId / targetDataLakeId claims. */
  async release(id: string, organizationId: string): Promise<boolean> {
    const res = await this.model.deleteMany({ _id: id, organizationId }, { hardDelete: true });
    const deleted = (res?.deletedCount ?? 0) > 0;
    if (deleted) await releaseLakeClaimBestEffort(id);
    return deleted;
  }

  async claimForSync(id: string): Promise<string | null> {
    const claimToken = randomUUID();
    const claimed = await this.model.findOneAndUpdate(
      {
        _id: id,
        ...NOT_DISABLED,
        $or: [
          // null matches a binding written before status existed; 'error' lets a manual re-sync retry a reconnect.
          { status: { $in: ['connected', 'error', null] } },
          ...staleSyncClaimClauses().map(clause => ({ status: 'syncing', ...clause })),
        ],
      },
      {
        $set: { status: 'syncing', syncClaimedAt: new Date(), ingestClaimToken: claimToken },
        $unset: { activeIngestBatchId: '' },
      }
    );
    return claimed !== null ? claimToken : null;
  }

  async disableIfNoLiveSyncClaim(id: string, organizationId: string): Promise<{ wasEnabled: boolean } | null> {
    const disabled = await this.model.findOneAndUpdate(noLiveSyncClaimFilter(id, organizationId), {
      $set: { enabled: false },
    });
    return disabled ? { wasEnabled: disabled.enabled !== false } : null;
  }

  async markDisconnecting(
    id: string,
    organizationId: string
  ): Promise<{ stamp: Date; created: boolean; previousEnabled: boolean } | null> {
    const stamp = new Date();
    // The pre-update document is what tells a creator apart from a re-stamp.
    // $and, not $or: the base filter's top-level $or is the live-sync guard.
    const previous = await this.model.findOneAndUpdate(
      {
        ...noLiveSyncClaimFilter(id, organizationId),
        $and: [
          {
            $or: [
              { disconnectRequestedAt: { $in: [null] } },
              { disconnectRequestedAt: { $lte: new Date(stamp.getTime() - GITHUB_DISCONNECT_STALL_MS) } },
            ],
          },
        ],
      },
      { $set: { enabled: false, disconnectRequestedAt: stamp } }
    );
    if (!previous) return null;
    return { stamp, created: !previous.disconnectRequestedAt, previousEnabled: previous.enabled !== false };
  }

  async cancelDisconnect(id: string, organizationId: string, stamp: Date, enabled: boolean): Promise<boolean> {
    const res = await this.model.updateOne(
      { _id: id, organizationId, disconnectRequestedAt: stamp },
      { $set: { enabled }, $unset: { disconnectRequestedAt: '' } }
    );
    return res.matchedCount > 0;
  }

  async touchDisconnect(id: string): Promise<boolean> {
    const res = await this.model.updateOne(
      { _id: id, disconnectRequestedAt: { $ne: null } },
      { $set: { disconnectRequestedAt: new Date() } }
    );
    return res.matchedCount > 0;
  }

  async adoptSyncClaim(
    id: string,
    activeIngestBatchId: string,
    claimToken: string
  ): Promise<{ token: string; enabled: boolean } | null> {
    const rotatedToken = randomUUID();
    const adopted = await this.model.findOneAndUpdate(
      { _id: id, status: 'syncing', activeIngestBatchId, ingestClaimToken: claimToken },
      { $set: { syncClaimedAt: new Date(), ingestClaimToken: rotatedToken } },
      { new: true }
    );
    return adopted ? { token: rotatedToken, enabled: adopted.enabled !== false } : null;
  }

  async renewSyncClaim(id: string, activeIngestBatchId: string, expectedToken: string): Promise<string | null> {
    const rotatedToken = randomUUID();
    const renewed = await this.model.findOneAndUpdate(
      {
        _id: id,
        ...NOT_DISABLED,
        status: 'syncing',
        ingestClaimToken: expectedToken,
        $or: [{ activeIngestBatchId: { $in: [null] } }, { activeIngestBatchId }],
      },
      { $set: { syncClaimedAt: new Date(), activeIngestBatchId, ingestClaimToken: rotatedToken } }
    );
    return renewed !== null ? rotatedToken : null;
  }

  async releaseSyncClaim(
    id: string,
    expectedToken: string,
    lastError: string | null,
    status: 'connected' | 'error' = 'connected'
  ): Promise<(IOrgGitHubLakeConnectionDocument & IMongoDocument) | null> {
    return this.model.findOneAndUpdate(
      { _id: id, status: 'syncing', ingestClaimToken: expectedToken },
      {
        $set: { status, lastError: lastError ? redactLastError(lastError) : null },
        $unset: { activeIngestBatchId: '', ingestClaimToken: '' },
      },
      { new: true }
    );
  }

  async recordSynced(
    id: string,
    expectedToken: string,
    { commitSha, defaultBranch }: { commitSha: string; defaultBranch: string }
  ): Promise<(IOrgGitHubLakeConnectionDocument & IMongoDocument) | null> {
    return this.model.findOneAndUpdate(
      { _id: id, status: 'syncing', ingestClaimToken: expectedToken },
      {
        $set: {
          status: 'connected',
          lastError: null,
          lastSyncedCommitSha: commitSha,
          lastSyncedAt: new Date(),
          defaultBranch,
        },
        $unset: { activeIngestBatchId: '', ingestClaimToken: '' },
      },
      { new: true }
    );
  }

  async setEnabledForLake(targetDataLakeId: string, enabled: boolean): Promise<boolean> {
    // An unarchive must not revive a connection whose disconnect purge is still running.
    const filter = enabled ? { targetDataLakeId, disconnectRequestedAt: null } : { targetDataLakeId };
    const res = await this.model.updateOne(filter, { $set: { enabled } });
    return res.matchedCount > 0;
  }

  /** Best-effort visibility for a failure outside any sync claim (e.g. the connect-time enqueue). */
  async recordLastError(id: string, lastError: string): Promise<boolean> {
    const res = await this.model.updateOne({ _id: id }, { $set: { lastError: redactLastError(lastError) } });
    return res.matchedCount > 0;
  }
}

export const orgGitHubLakeConnectionRepository = new OrgGitHubLakeConnectionRepository(OrgGitHubLakeConnection);

export default OrgGitHubLakeConnection;
