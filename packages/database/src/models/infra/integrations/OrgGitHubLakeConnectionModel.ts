import {
  IOrgGitHubLakeConnectionDocument,
  IOrgGitHubLakeConnectionRepository,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

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

  /** Hard delete: a soft-deleted row would keep the unique repositoryId / targetDataLakeId claims. */
  async release(id: string, organizationId: string): Promise<boolean> {
    const res = await this.model.deleteMany({ _id: id, organizationId }, { hardDelete: true });
    return (res?.deletedCount ?? 0) > 0;
  }
}

export const orgGitHubLakeConnectionRepository = new OrgGitHubLakeConnectionRepository(OrgGitHubLakeConnection);

export default OrgGitHubLakeConnection;
