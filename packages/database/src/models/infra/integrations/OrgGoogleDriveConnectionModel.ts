import {
  IOrgGoogleDriveConnectionDocument,
  IOrgGoogleDriveConnectionRepository,
  IGoogleDriveConnectionHealthUpdate,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const MAX_LAST_ERROR_LEN = 500;

/**
 * lastError is client-visible (a response-DTO member, no select:false) and its predictable writer is
 * `lastError: err.message` from a provider (Gaxios) failure, which can carry URLs, query strings, or
 * token fragments. Strip token-shaped runs and cap the length in this one writer so raw provider
 * output can't leak into an admin-visible field.
 */
function redactLastError(message: string): string {
  const redacted = message.replace(/[A-Za-z0-9._~+/=-]{24,}/g, '[redacted]');
  return redacted.length > MAX_LAST_ERROR_LEN ? `${redacted.slice(0, MAX_LAST_ERROR_LEN)}...` : redacted;
}

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
      enum: ['connected', 'syncing', 'needs_reconnect', 'credential_error'],
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

  /** The enabled connection feeding a given lake in a given org, if any. */
  async findByDataLakeId(
    targetDataLakeId: string,
    organizationId: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ targetDataLakeId, organizationId, enabled: true });
  }

  /**
   * The connection that has claimed a given Drive folder, if any. Deliberately GLOBAL - it answers
   * "is this folder claimed by ANY org" (the point of the global-unique index). SECURITY: the
   * returned document (which excludes the credential) is a server-side claim check; never hand it to
   * a cross-org caller.
   */
  async findByDriveFolderId(
    driveFolderId: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ driveFolderId });
  }

  /**
   * Load a connection WITH its encrypted credential, scoped to an org.
   * SECURITY: org-scoped so it cannot hand one org's `oauthRefreshToken` to another. Decrypt
   * server-side only; never expose it.
   */
  async findByIdWithCredentials(
    id: string,
    organizationId: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    const result = await this.model.findOne({ _id: id, organizationId }).select('+oauthRefreshToken');
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
    // Clear the error on a healthy update; redact + truncate otherwise (lastError is client-visible
    // and its predictable caller is a raw provider err.message - see redactLastError).
    set.lastError = update.lastError ? redactLastError(update.lastError) : null;
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

  /**
   * Guarded ingest lock: flip status to 'syncing' only if it is not already 'syncing'. The `$ne`
   * conjunct makes this a single atomic compare-and-set - a losing concurrent caller matches
   * nothing and gets `null`, so exactly one run proceeds. Returns whether THIS caller claimed it.
   */
  async claimForSync(id: string): Promise<boolean> {
    const claimed = await this.model.findOneAndUpdate(
      { _id: id, status: { $ne: 'syncing' } },
      { $set: { status: 'syncing' } }
    );
    return claimed !== null;
  }

  /**
   * Guarded release for the failure path: 'syncing' -> 'connected' only. The `status: 'syncing'`
   * conjunct means it no-ops if a terminal status (e.g. credential_error) was set underneath, so a
   * failed run never overwrites a real error state.
   */
  async releaseSyncClaim(id: string): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.model.findOneAndUpdate({ _id: id, status: 'syncing' }, { $set: { status: 'connected' } }, { new: true });
  }
}

export const orgGoogleDriveConnectionRepository = new OrgGoogleDriveConnectionRepository(OrgGoogleDriveConnection);

export default OrgGoogleDriveConnection;
