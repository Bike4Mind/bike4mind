import {
  IOrgGoogleDriveConnectionDocument,
  IOrgGoogleDriveConnectionRepository,
  IGoogleDriveConnectionHealthUpdate,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * Organization-level Google Drive connection: binds one Drive folder to one data lake as an
 * ingest source. Org-owned credential (not the per-user User.googleDrive), following the
 * OrgGitHubConnection / OrgJiraConnection pattern (org-scoped, secret excluded from default
 * reads, encrypted at rest by the service layer). See the #1587 auth-model resolution.
 *
 * v1 auth mode is 'oauth'; 'service_account' is reserved for a deferred cloud-only mode.
 */
const OrgGoogleDriveConnectionSchema = new Schema<IOrgGoogleDriveConnectionDocument>(
  {
    organizationId: { type: String, required: true },
    authMode: { type: String, enum: ['oauth', 'service_account'], required: true },
    // trim + match at the DB layer too: isValidDriveFolderId lives in apps/client and isn't
    // reachable from packages/database, so without this 'F' / 'F ' / ' F' would be distinct unique
    // keys for one folder. Keep the pattern in sync with driveClient.isValidDriveFolderId.
    driveFolderId: { type: String, required: true, trim: true, match: /^[A-Za-z0-9_-]{1,256}$/ },
    folderName: { type: String },
    targetDataLakeId: { type: String, required: true },

    // OAuth refresh token. select:false so it never leaks into default reads or toJSON. NO writer
    // exists yet - the org-owned connect flow that persists this (and MUST encryptToken it first)
    // lands with issue D. Encryption is call-site convention here, as with the sibling Org*
    // connections and User.googleDrive; a pre-save encrypt guard should land with that first writer.
    oauthRefreshToken: { type: String, select: false },

    // Metadata
    connectedBy: { type: String, required: true },
    connectedAt: { type: Date, default: Date.now },
    enabled: { type: Boolean, default: true },

    // Health tracking
    status: {
      type: String,
      enum: ['connected', 'needs_reconnect', 'credential_error'],
      default: 'connected',
    },
    lastError: { type: String },
    lastUsedAt: { type: Date },
    lastPolledAt: { type: Date },

    // Incremental-sync resumption (Drive changes pageToken)
    syncCursor: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// FIRST-CLAIM-WINS on the Drive folder id: the unique index rejects a SECOND row for a folder
// already claimed. It does NOT verify the first claimant actually owns the folder - that ownership
// check (a files.get capabilities lookup with the connecting user's credential) lands with the
// connect flow (issue D). This is a NEW pattern, not sibling precedent: the sibling Org* connections
// scope uniqueness to the org and never make a third-party resource id globally unique; making
// driveFolderId global is a deliberate anti-double-claim choice.
OrgGoogleDriveConnectionSchema.index({ driveFolderId: 1 }, { unique: true, name: 'org_gdrive_conn_folder_id' });

// A lake is fed by at most one Drive folder (v1: one-folder-per-lake).
OrgGoogleDriveConnectionSchema.index({ targetDataLakeId: 1 }, { unique: true, name: 'org_gdrive_conn_lake_id' });

// Org lookups - NON-unique: an org may connect several folders/lakes.
OrgGoogleDriveConnectionSchema.index({ organizationId: 1 }, { name: 'org_gdrive_conn_org_id' });

export interface IOrgGoogleDriveConnectionModel extends Model<IOrgGoogleDriveConnectionDocument & IMongoDocument> {}

export const OrgGoogleDriveConnection: IOrgGoogleDriveConnectionModel =
  mongoose.models.OrgGoogleDriveConnection ??
  model<IOrgGoogleDriveConnectionDocument>('OrgGoogleDriveConnection', OrgGoogleDriveConnectionSchema);

class OrgGoogleDriveConnectionRepository
  extends BaseRepository<IOrgGoogleDriveConnectionDocument & IMongoDocument>
  implements IOrgGoogleDriveConnectionRepository
{
  /** All enabled connections for an org (excludes credentials). */
  async findByOrganizationId(organizationId: string): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument)[]> {
    return this.find({ organizationId, enabled: true });
  }

  /** All connections for an org regardless of enabled status (admin/management views). */
  async findByOrganizationIdAny(
    organizationId: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument)[]> {
    return this.find({ organizationId });
  }

  /** The enabled connection feeding a given lake, if any. */
  async findByDataLakeId(
    targetDataLakeId: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ targetDataLakeId, enabled: true });
  }

  /** The connection that has claimed a given Drive folder, if any (claim checks). */
  async findByDriveFolderId(
    driveFolderId: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ driveFolderId });
  }

  /**
   * Load a connection WITH its encrypted credential.
   * SECURITY: returns the encrypted `oauthRefreshToken`. Decrypt server-side only; never expose it.
   */
  async findByIdWithCredentials(id: string): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findById(id).select('+oauthRefreshToken');
    return result?.toJSON() || null;
  }

  /** Update health state; clears `lastError` on a healthy update (mirrors OrgGitHubConnection.updateHealthInfo). */
  async updateHealth(
    id: string,
    update: IGoogleDriveConnectionHealthUpdate
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    const set: Record<string, unknown> = { status: update.status };
    if (update.lastUsedAt !== undefined) set.lastUsedAt = update.lastUsedAt;
    if (update.lastPolledAt !== undefined) set.lastPolledAt = update.lastPolledAt;
    // Explicitly clear the error when none is supplied so a recovered connection doesn't keep a stale message.
    set.lastError = update.lastError ?? null;
    return this.model.findByIdAndUpdate(id, { $set: set }, { new: true });
  }

  /** Advance the incremental-sync cursor after a sync batch is durably created. */
  async updateSyncCursor(
    id: string,
    syncCursor: string,
    polledAt: Date
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.model.findByIdAndUpdate(id, { $set: { syncCursor, lastPolledAt: polledAt } }, { new: true });
  }
}

export const orgGoogleDriveConnectionRepository = new OrgGoogleDriveConnectionRepository(OrgGoogleDriveConnection);

export default OrgGoogleDriveConnection;
