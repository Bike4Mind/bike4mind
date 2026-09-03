import {
  IOrgGoogleDriveConnectionDocument,
  IOrgGoogleDriveConnectionRepository,
  IGoogleDriveConnectionHealthUpdate,
  IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { randomUUID } from 'crypto';

const MAX_LAST_ERROR_LEN = 500;

// An UNCHAINED 'syncing' claim older than this is treated as abandoned and is reclaimable. Such a
// claim is refreshed once per run, so the longest a live one can go un-refreshed is one invocation:
// the ingest queue's Lambda has a hard 10-minute timeout (visibility 12 min - see infra/queues.ts),
// and anything older is a dead owner.
const SYNC_CLAIM_STALE_MS = 20 * 60 * 1000; // 20 min, comfortably past the 10-min Lambda ceiling

// A CHAINED claim (one carrying activeIngestBatchId) is a different measurement. It is refreshed at
// each slice boundary, so the un-refreshed interval is the continuation message's QUEUE WAIT, not the
// run length - and driveLakeIngestQueue is shared across every Drive connection, so two full-length
// messages ahead of a continuation already exceed the bound above. Stealing such a claim is not a
// harmless reclaim: the poll that takes it runs a FRESH sync with no resumeBatchId, so it never
// subtracts what the chain already uploaded (still `pending`, hence invisible to the ordinary diff)
// and re-ingests the tail as new ADDs - the exact duplicate spiral chaining exists to prevent. Hence
// a longer bound here, sized for several full-length messages queued ahead of a continuation. Still
// finite, so an abandoned chain cannot wedge a connection in 'syncing' forever - but the reclaim is
// reachable only from an OPERATOR-INITIATED path (the manual Re-sync button, which calls claimForSync
// directly), not automatically: findDueForPoll filters on status:'connected', so the scheduled poll
// never re-enqueues onto a wedged 'syncing' connection, and an abandoned chain's own in-flight message
// gives up first (MAX_INGEST_REDRIVES x its delay tops out under 20 min). A stuck-connection reaper
// that reclaims automatically would be separate work, not something this bound provides.
const CHAINED_SYNC_CLAIM_STALE_MS = 60 * 60 * 1000; // 60 min, ~5 back-to-back 12-min visibility windows

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

    // OAuth refresh token. select:false so it never leaks into default reads or toJSON. Written by
    // the connect flow (POST /api/data-lakes/drive-sync), which copies the connecting user's
    // already-encrypted refresh token. Encryption is CALL-SITE convention (as with the sibling Org*
    // connections and User.googleDrive) because the crypto helpers live in apps/client and are not
    // reachable from packages/database - so the encrypt/isEncrypted guard lives at that writer, not a
    // pre-save hook here. A pre-save hook cannot encrypt without the key it has no access to.
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
    // When the current 'syncing' claim was taken; a stale one is reclaimable (see claimForSync).
    syncClaimedAt: { type: Date },
    // The batch a sliced ingest chain is filling; the id a continuation presents to adoptSyncClaim.
    activeIngestBatchId: { type: String },
    // The one-time-use token a continuation must ALSO present to adoptSyncClaim, minted fresh by
    // each renewSyncClaim/adoptSyncClaim call and never reused - see adoptSyncClaim's doc comment for
    // why activeIngestBatchId alone (unchanged for a whole chain) cannot serve as this CAS token.
    ingestClaimToken: { type: String },

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
// already claimed. The index alone does NOT verify the claimant owns the folder; that ownership check
// - a files.get read probe with the connecting user's own credential (getFolderAccess) - runs BEFORE
// the claim in drive-sync.ts, so a folder can only be claimed by someone who can actually read it
// (without it, a manager could squat a folder id they don't own and lock out its real owner). This is
// a NEW pattern, not sibling precedent: the sibling Org* connections scope uniqueness to the org and
// never make a third-party resource id globally unique; making driveFolderId global is a deliberate
// anti-double-claim choice.
OrgGoogleDriveConnectionSchema.index({ driveFolderId: 1 }, { unique: true, name: 'org_gdrive_conn_folder_id' });

// A lake is fed by at most one Drive folder (v1: one-folder-per-lake).
OrgGoogleDriveConnectionSchema.index({ targetDataLakeId: 1 }, { unique: true, name: 'org_gdrive_conn_lake_id' });

// Org lookups - NON-unique: an org may connect several folders/lakes.
OrgGoogleDriveConnectionSchema.index({ organizationId: 1 }, { name: 'org_gdrive_conn_org_id' });

// Credential-owner lookup (findByConnectedBy) - the profile-disconnect revoke needs every connection
// whose credential belongs to the disconnecting user, across orgs, so this is deliberately unscoped.
OrgGoogleDriveConnectionSchema.index({ connectedBy: 1 }, { name: 'org_gdrive_conn_connected_by' });

// Scheduled re-sync poll scan (findDueForPoll): enabled + status equality, then lastPolledAt for both
// the cutoff range and the oldest-first sort. Small collection today, but the sort is served from the
// index rather than an in-memory sort as the fleet grows.
OrgGoogleDriveConnectionSchema.index(
  { enabled: 1, status: 1, lastPolledAt: 1 },
  { name: 'org_gdrive_conn_due_for_poll' }
);

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
   * The connection bound to a lake regardless of `enabled`, and deliberately GLOBAL. The caller is
   * the lake-purge teardown: it runs after the lake's org is no longer resolvable, and a disabled row
   * still holds the unique driveFolderId claim, so neither the org scope nor the enabled filter of
   * findByDataLakeId can be applied without stranding the folder. SECURITY: server-side only.
   */
  async findByDataLakeIdAny(
    targetDataLakeId: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.findOne({ targetDataLakeId });
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
   * Every connection whose stored credential belongs to a given user (`connectedBy` is re-stamped
   * with the credential in updateCredential, so it always names the credential's owner). Deliberately
   * CROSS-ORG: the caller is the user's own profile-disconnect, which revokes their Google grant and
   * so breaks these connections whichever org they belong to. Excludes credentials.
   */
  async findByConnectedBy(connectedBy: string): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument)[]> {
    return this.find({ connectedBy });
  }

  /**
   * Enabled connections due for a scheduled re-sync poll: never polled, or last polled before the
   * cutoff. Restricted to `status: 'connected'` so the poll never enqueues over an in-flight sync
   * ('syncing'), a broken credential ('credential_error'), or a folder that needs reconnecting
   * ('needs_reconnect') - the ingest handler's claimForSync is the ultimate race guard, but filtering
   * here keeps a dead connection from being re-enqueued every run. Capped and oldest-first (a null
   * lastPolledAt sorts first) so a large fleet drains fairly across runs. Mirrors
   * dataLakeBatchRepository.findStuck (the cron scan-and-cap precedent).
   */
  async findDueForPoll(cutoff: Date, limit: number): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument)[]> {
    return this.model
      .find({
        enabled: true,
        status: 'connected',
        $or: [{ lastPolledAt: null }, { lastPolledAt: { $exists: false } }, { lastPolledAt: { $lt: cutoff } }],
      })
      .sort({ lastPolledAt: 1 })
      .limit(limit)
      .then(docs => docs.map(d => d.toJSON()));
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

  /**
   * (Re)write the org-owned encrypted refresh token and re-stamp `connectedBy` to the re-syncing user
   * (the identity ingest runs as - see driveLakeIngest), org-scoped so one org can't overwrite
   * another's. The value must already be encrypted by the caller (crypto is not reachable from
   * packages/database).
   *
   * The credential + connectedBy are written UNCONDITIONALLY, but status/lastError are healed to
   * 'connected' only from a NON-'syncing' state (pipeline `$cond`): a Re-sync issued while an ingest
   * is in flight must not flip 'syncing' -> 'connected', or claimForSync would let the re-triggered
   * run claim ON TOP of the live one and both would walk the folder (duplicate FabFiles). Leaving the
   * status 'syncing' makes the new run defer behind the running one instead.
   */
  async updateCredential(
    id: string,
    organizationId: string,
    encryptedRefreshToken: string,
    connectedBy: string
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    return this.model.findOneAndUpdate(
      { _id: id, organizationId },
      [
        {
          $set: {
            oauthRefreshToken: encryptedRefreshToken,
            connectedBy,
            status: { $cond: [{ $eq: ['$status', 'syncing'] }, '$status', 'connected'] },
            lastError: { $cond: [{ $eq: ['$status', 'syncing'] }, '$lastError', null] },
          },
        },
      ],
      { new: true }
    );
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
    // Every caller here moves the connection out of 'syncing' into an ERROR state (a credential
    // failure, a disconnect) and must be able to force it, so this is deliberately not claim-guarded.
    // An ingest run ending its OWN claim goes through releaseSyncClaim instead, which is. Either way
    // the chain id/token goes with the claim, or a stale continuation could adopt one nobody holds.
    const unset = update.status === 'syncing' ? undefined : { activeIngestBatchId: '', ingestClaimToken: '' };
    return this.model.findByIdAndUpdate(id, { $set: set, ...(unset && { $unset: unset }) }, { new: true });
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
   * Guarded ingest lock: atomically flip status to 'syncing' (stamping `syncClaimedAt`) only when the
   * connection is idle ('connected') OR its existing 'syncing' claim is STALE. A single atomic
   * compare-and-set - a losing concurrent caller matches nothing and gets `null`, so exactly one run
   * proceeds.
   *
   * Deliberately NOT `$ne: 'syncing'`: that also claimed OVER a `credential_error`/`needs_reconnect`
   * connection, and a later release would erase the real error state (leaving it reading healthy with
   * a broken credential). And a plain equality on 'syncing' could never recover a claim left by a
   * process that died past the Lambda timeout without releasing - the connection would be wedged in
   * 'syncing' forever with no operator path back. The stale-claim arm makes that failure degrade to
   * "one ingest was lost" (reclaimable next run) instead of "this connection can never sync again".
   *
   * The staleness arm is SPLIT by whether the claim carries a chain token, because the two measure
   * different durations and stealing a live chain is far more damaging than stealing an idle claim -
   * see CHAINED_SYNC_CLAIM_STALE_MS.
   *
   * Returns the freshly-minted `ingestClaimToken` this claim is identified by (null if the claim was
   * lost). The caller must carry it into its own renewSyncClaim, which compare-and-sets on it.
   */
  async claimForSync(id: string): Promise<string | null> {
    const staleBefore = new Date(Date.now() - SYNC_CLAIM_STALE_MS);
    const chainedStaleBefore = new Date(Date.now() - CHAINED_SYNC_CLAIM_STALE_MS);
    const claimToken = randomUUID();
    const claimed = await this.model.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { status: 'connected' },
          // $in: [null] matches a missing field too - a claim that never started a chain.
          { status: 'syncing', activeIngestBatchId: { $in: [null] }, syncClaimedAt: { $lt: staleBefore } },
          {
            status: 'syncing',
            activeIngestBatchId: { $ne: null },
            syncClaimedAt: { $lt: chainedStaleBefore },
          },
        ],
      },
      // A fresh claim starts no chain, so the batch pointer left by a dead one is cleared - otherwise
      // a stale message could still present it to adoptSyncClaim and join a chain that is no longer
      // running. The token is REPLACED rather than cleared, for the same reason: it is what makes
      // renewSyncClaim a compare-and-set even before this claim has named a batch, so leaving it null
      // would let the dead chain's last slice renew straight back over this one.
      {
        $set: { status: 'syncing', syncClaimedAt: new Date(), ingestClaimToken: claimToken },
        $unset: { activeIngestBatchId: '' },
      }
    );
    return claimed !== null ? claimToken : null;
  }

  /**
   * Continuation-only take-over of a live claim (see the type docs): matches on the batch id AND the
   * one-time token this chain's previous slice minted (renewSyncClaim), so only that chain's own next
   * slice can pick the claim up. The claim therefore never returns to 'connected' between slices, which
   * is what keeps the re-sync poll from starting a competing walk mid-chain.
   *
   * The match is on `activeIngestBatchId` (unchanged for a whole chain, since it also names the batch
   * document to resume) AND `ingestClaimToken` (rotated to a fresh value on every successful adopt).
   * The batch id alone cannot be the CAS token: two deliveries of the SAME continuation message would
   * both match it and both win, since matching it doesn't consume it. Rotating a second field the
   * update also changes is what makes a redelivered duplicate lose - Mongo applies findOneAndUpdate
   * atomically, so only the first of two concurrent callers can observe the pre-rotation value.
   * Returns the freshly-minted token on success (for the caller to carry forward if it defers again),
   * or null if the take-over lost.
   */
  async adoptSyncClaim(id: string, activeIngestBatchId: string, claimToken: string): Promise<string | null> {
    const rotatedToken = randomUUID();
    const adopted = await this.model.findOneAndUpdate(
      { _id: id, status: 'syncing', activeIngestBatchId, ingestClaimToken: claimToken },
      { $set: { syncClaimedAt: new Date(), ingestClaimToken: rotatedToken } }
    );
    return adopted !== null ? rotatedToken : null;
  }

  /**
   * Hold the claim across a slice boundary; guarded on 'syncing' so it cannot resurrect a released one.
   * `expectedToken` is the one-time token this run currently holds - minted by its own claimForSync, or
   * rotated onto it by adoptSyncClaim - and it is REQUIRED, because it is the whole compare-and-set.
   * Every path that takes the claim away either rotates that token to a value this caller cannot know
   * (claimForSync, adoptSyncClaim, a rival renew) or clears it outright (releaseSyncClaim, updateHealth
   * leaving 'syncing'), so a caller that already lost the claim presents a token nobody stores any more
   * and matches nothing. releaseSyncClaim compare-and-sets on the same token, for the same reason.
   *
   * The batch id cannot carry that guard on its own, in either direction: it is ABSENT on a first slice
   * (which is renewing precisely to name its batch for the first time), and on a later slice it is
   * fixed for the whole chain, so it cannot tell "my own live chain" apart from "a chain I used to hold
   * and lost to a reclaim/disconnect/reconnect" - both read back the same id once a new owner renews or
   * adopts. Hence the $or is only over the batch pointer, and describes the two states a legitimate
   * token-holder can be in:
   *   - null - a first slice straight off its own claimForSync, about to point the connection at the
   *     batch it just planned (also the state a continuation lands in when its adopt lost and it fell
   *     back to a fresh claim);
   *   - the same id - a later slice re-renewing the chain it is already running.
   *
   * Always mints a fresh `ingestClaimToken` on success and returns it - the caller carries it into the
   * next slice's continuation payload for adoptSyncClaim to present.
   */
  async renewSyncClaim(id: string, activeIngestBatchId: string, expectedToken: string): Promise<string | null> {
    const rotatedToken = randomUUID();
    const renewed = await this.model.findOneAndUpdate(
      {
        _id: id,
        status: 'syncing',
        ingestClaimToken: expectedToken,
        // $in: [null] matches a missing field too - a claim that has not named a batch yet.
        $or: [{ activeIngestBatchId: { $in: [null] } }, { activeIngestBatchId }],
      },
      { $set: { syncClaimedAt: new Date(), activeIngestBatchId, ingestClaimToken: rotatedToken } }
    );
    return renewed !== null ? rotatedToken : null;
  }

  /**
   * The ONE way an ingest run ends its own claim - both the failure exit and the success exit come
   * through here. 'syncing' -> 'connected', guarded on the status AND on `expectedToken`.
   *
   * The status conjunct means it no-ops if a terminal status (e.g. credential_error) was set
   * underneath, so a run never overwrites a real error state. The token conjunct means a run that has
   * already LOST its claim - to a stale-claim reclaim, or to a disconnect/reconnect healing the status
   * out from under it - cannot release the NEW owner's claim on its way out, which would flip a live
   * ingest back to 'connected' and let the re-sync poll start a competing walk over the same folder.
   * Losing that race is a no-op returning null, and is not an error: the new owner releases when it
   * is done. This is the release-side half of the compare-and-set renewSyncClaim does for the chain.
   *
   * `lastError` is REQUIRED and nullable rather than optional precisely because both exits share this
   * method: a string records the failure, null heals (matching updateHealth's contract for a healthy
   * update). There is deliberately no "leave whatever is stored" arm - every caller knows which of the
   * two it is, and an omitted argument would silently pick one of them.
   *
   * Stamps `lastPolledAt` too: a connection that fails DETERMINISTICALLY (a subtree the credential
   * cannot list, a Mongo timeout) would otherwise heal back to 'connected' with lastPolledAt
   * unchanged, stay due, and be re-enqueued at every hourly tick - each attempt re-walking the folder
   * before failing again. Stamping keeps the 6h poll cadence on the failure path, matching every
   * non-throwing exit (findDueForPoll's status filter can't help once the release flips it back).
   *
   * A recorded `lastError` is the operator-visible half of that: without it, such a connection reads
   * `connected` with a fresh poll time and no signal anywhere that its syncs keep dying. Redacted
   * like updateHealth's, since the caller's message is a raw provider/driver `err.message`.
   */
  async releaseSyncClaim(
    id: string,
    expectedToken: string,
    lastError: string | null
  ): Promise<(IOrgGoogleDriveConnectionDocument & IMongoDocument) | null> {
    // The chain (if any) is over once the claim goes; leaving the id/token would let an in-flight
    // continuation message adopt a claim nobody holds.
    return this.model.findOneAndUpdate(
      { _id: id, status: 'syncing', ingestClaimToken: expectedToken },
      {
        $set: {
          status: 'connected',
          lastPolledAt: new Date(),
          // Empty-string-to-null matches updateHealth: a caller whose err.message is blank has nothing
          // to report, and storing '' would read as a present error on the client.
          lastError: lastError ? redactLastError(lastError) : null,
        },
        $unset: { activeIngestBatchId: '', ingestClaimToken: '' },
      },
      { new: true }
    );
  }

  /**
   * Delete a connection (org-scoped), releasing its global Drive-folder claim. HARD delete on purpose:
   * a soft-deleted/disabled row would keep the unique driveFolderId index populated and block re-claim.
   */
  async release(id: string, organizationId: string): Promise<boolean> {
    const res = await this.model.deleteMany({ _id: id, organizationId }, { hardDelete: true });
    return (res?.deletedCount ?? 0) > 0;
  }
}

export const orgGoogleDriveConnectionRepository = new OrgGoogleDriveConnectionRepository(OrgGoogleDriveConnection);

export default OrgGoogleDriveConnection;
