import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  User,
  adminSettingsRepository,
  changeStorageSize,
  dataLakeRepository,
  dataLakeBatchRepository,
  fabFileChunkRepository,
  fabFileRepository,
  orgGoogleDriveConnectionRepository,
  scopedSettingsRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import {
  BATCH_NON_TERMINAL_STATUSES,
  DATALAKE_TAG_STRENGTH,
  KnowledgeType,
  FabFileSourceType,
  isDataLakeTagName,
  matchesTagPrefixArm,
  type IUserDocument,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { createFabFile } from '@server/managers/fabFileManager';
import defineAbilitiesFor from '@server/auth/ability';
import { getFilesStorage } from '@server/utils/storage';
import { getValidConnectionDriveAccessToken } from '@server/integrations/google/drive/common';
import { createDriveClient } from '@server/integrations/google/drive/driveClient';
import { walkFolder, fetchDriveFileContent } from '@server/integrations/google/drive/driveContent';
import { finalizeBatchIfComplete } from '@server/queueHandlers/dataLakeBatchProgress';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { z, ZodError } from 'zod';

const Payload = z.object({
  connectionId: z.string(),
  redriveCount: z.number().int().min(0).default(0),
  // Set only on a self-re-enqueued continuation: the batch the previous slice was filling, and the
  // record of what has already been ingested. Absent on every externally-triggered sync, so those
  // always start a fresh chain.
  resumeBatchId: z.string().optional(),
  // The one-time CAS token adoptSyncClaim must present alongside resumeBatchId - see
  // OrgGoogleDriveConnection.ingestClaimToken. Always set together with resumeBatchId.
  claimToken: z.string().optional(),
  // Continuation depth, incremented per self-re-enqueue and bounded by MAX_INGEST_SLICES.
  slice: z.number().int().min(0).default(0),
});

// A claim loser re-enqueues itself (with a delay) so a GENUINE second sync - files added to the
// folder while a long run is mid-loop - isn't silently dropped until the next scheduled poll.
// Bounded so a permanently-losing message can't spin: past this many redrives we give up and let
// the next real sync pick the files up. Delay x max stays comfortably past the handler's 10-minute
// in-flight ceiling.
const MAX_INGEST_REDRIVES = 12;
const INGEST_REDRIVE_DELAY_SECONDS = 90;

// Per-file hard cap. Files are fetched and uploaded ONE at a time (only one buffer is ever live),
// so this bounds peak memory well under the ingest queue Lambda's 1024 MB default. An oversized
// file is skipped-and-counted (before the download when the size is known up front), so the failure
// mode is a skipped file rather than an OOM that kills the whole run mid-loop. A streaming path for
// genuinely large files is the "very large folders" follow-up.
const MAX_INGEST_FILE_BYTES = 50 * 1024 * 1024;

// Stop starting another file once the invocation has less than this left, and yield to a continuation
// slice instead of being killed mid-file. Sized for the slowest realistic single file: a
// MAX_INGEST_FILE_BYTES download plus its upload, plus a retire that may run a full deleteFabFile
// (chunks, search-index docs, S3 object, quota). Getting killed instead of yielding is what used to
// duplicate the tail, so this buffer is the thing that actually keeps a large folder converging.
const INGEST_DEADLINE_BUFFER_MS = 90_000;

// Wall-clock budget when the caller cannot supply the Lambda's real remaining time (tests, the
// self-host worker, any non-Lambda host). Keeps the guard active by default rather than silently
// absent. Mirrors extractLakeMemory's DEFAULT_RUN_BUDGET_MS, against the same 10-minute ceiling.
const DEFAULT_RUN_BUDGET_MS = 9 * 60_000;

// Hard ceiling on how many slices ONE ingest chain runs before it stops re-enqueuing itself, so a
// pathological folder cannot turn one sync into an unbounded run of invocations. Coverage is not lost
// when it trips: the files earlier slices uploaded become durable, non-`pending` lake members, so the
// next scheduled poll's walk no longer proposes them and the remainder ingests in a fresh chain. That
// holds because the chunk pipeline each upload enqueues has drained by then - the same durability the
// claim's staleness bound leans on, and the reason a chained claim must not be stolen mid-chain.
export const MAX_INGEST_SLICES = 20;

// Per-sync candidate cap. This is NO LONGER a throughput bound - the deadline guard above yields to a
// continuation slice rather than timing out mid-loop, so the ingestable count is bounded by
// MAX_INGEST_SLICES x a slice's throughput (tens of thousands of files) and not by one invocation.
// What this cap still bounds is the part that CANNOT be sliced: the walk and the diff, which hold the
// whole folder listing and this connection's whole stored set in memory in EVERY slice, and must
// complete inside one invocation before any file is touched. Enforced up front, before any membership
// write, so an over-cap folder is refused with nothing changed. Beyond it the folder should be split
// into subfolders connected separately.
//
// Also, indirectly, a bound on the size of ONE batch document: every candidate a chain ingests gets a
// manifest entry in `files[]` on this same DataLakeBatch doc, and both claimFileStatus's positional
// update and every finalize check read the whole document. Raising this constant further raises that
// document's worst-case size (and, with failedFileNames also accumulating, moves it closer to the 16MB
// BSON ceiling) as well as the walk+diff cost the comment above is about.
export const MAX_INGEST_CANDIDATES = 20000;

/**
 * Has a Drive file changed since it was ingested? `md5Checksum` is exact, but Google Editors files
 * (Docs/Sheets/Slides) carry no md5, so fall back to `modifiedTime` for those. Conservative by
 * design: when neither signal can be compared (a pre-provenance row, or a file Drive reports with
 * neither field) it returns false, so a re-sync never churns a file it cannot PROVE is stale.
 * modifiedTime uses strict-newer so a re-listed-but-unedited file (same timestamp) is unchanged.
 */
export function hasDriveFileChanged(
  prior: { driveMd5Checksum?: string; driveModifiedTime?: Date | string },
  fresh: { md5Checksum?: string; modifiedTime?: string }
): boolean {
  if (fresh.md5Checksum && prior.driveMd5Checksum) {
    return fresh.md5Checksum !== prior.driveMd5Checksum;
  }
  if (fresh.modifiedTime && prior.driveModifiedTime) {
    return new Date(fresh.modifiedTime).getTime() > new Date(prior.driveModifiedTime).getTime();
  }
  return false;
}

/**
 * Background reconcile of an org Google Drive folder against a data lake (#1589, #1591). Walks the
 * folder, diffs it against the files this connection has already ingested, and applies the delta:
 * ADD a new file, RE-INGEST an edited one, and REMOVE from the lake one that is gone from the folder.
 * Adds/re-ingests fetch and upload ONE file at a time - creating a lake-tagged FabFile and its
 * batch-manifest entry BEFORE the bytes land - and let the existing S3 objectCreated -> chunk ->
 * vectorize -> finalize pipeline do the rest. Both the manual Re-sync button and the scheduled poll
 * cron (driveLakeResyncPoll) enqueue onto this one handler, so there is a single delta-aware apply path.
 *
 * Apply order is deliberate. The candidate cap is enforced FIRST, before any membership write, so an
 * over-cap folder is refused with nothing changed (an early removal on a run that then bails would evict
 * files it never re-ingests). Genuine deletes (gone from the folder) are then unpicked up front - they
 * have no replacement pending, so nothing is lost by removing them early. An EDITED file's stale copy is
 * NOT retired until its fresh replacement has been uploaded in the loop below: retiring it up front would
 * evict a working lake member for good on any run where the re-fetch then fails a deterministic gate
 * (oversized / unsupported / export-too-large), since that skip creates no replacement.
 *
 * Retiring an edited file's stale copy is two steps, in this order, and the order is the point. FIRST an
 * unpick from THIS lake (removeFileFromLake), which is per-lake by construction - see the reserved-namespace
 * note in lakeMembership.ts. THEN, only when NO OTHER LAKE still claims the copy, a full delete through
 * fabFileService.deleteFabFile. A superseded Drive doc must leave the owner's Files entirely (its pre-edit
 * content must not stay retrievable, and one orphan copy per edit must not accumulate with its chunks,
 * embeddings, S3 object and storage quota) - but a copy a human curated into a SECOND lake must not be
 * yanked out of it by a background poll. A blanket soft-delete would do exactly that: `deletedAt` is
 * filtered by EVERY lake's read path, so a per-lake operation would have become a global one. Keeping the
 * membership unpick and gating the delete preserves the per-lake invariant instead of racing it.
 *
 * That gate has to test BOTH arms of the one membership predicate (buildDataLakeMembershipFilter), which is
 * what dataLakeService.findOtherLakeClaims does: the `datalake:` meta-tag, AND a `fileTagPrefix` match on a
 * file the other lake's creator owns. A meta-tag-only gate is a trap, because a file curated into a second
 * lake through that lake's PREFIX carries no meta-tag for it - the gate would read "nobody else wants this"
 * and delete a full member out of a lake it never looked at.
 *
 * The gate also refuses to delete a copy anyone but its owner can read - a direct user share, a group share,
 * or isGlobalRead. The delete is global, so it would take the share vector with it, and the replacement is
 * minted for connection.connectedBy alone and carries none, so there is nothing to hand the sharee instead;
 * they would be left with a notebook reference that getAccessibleFiles silently drops. The trade is the same
 * one the other-lake branch makes: a shared copy is left unpicked-but-alive, so it does accumulate one stale
 * orphan per edit (it drops out of findByDriveConnectionIdInDataLake once unpicked, and no later poll revisits
 * it), and the sharee reads pre-edit content. Recoverable staleness beats a silent, unrecoverable loss of
 * access. If Drive-lake files turn out never to be shared directly, this branch simply never fires.
 *
 * The full delete goes through fabFileService.deleteFabFile rather than a bare `deletedAt` stamp because
 * only that path also reaps the chunks, the per-model search-index docs, the session (notebook) links, the
 * S3 object and the owner's counted storage. A bare stamp leaves all of it billed and orphaned forever -
 * nothing reaps soft-deleted FabFiles outside whole-lake teardown. Two of those the user would MISS, so
 * they are carried onto the fresh copy first (carryForwardToReplacement): the notebook attachments, and the
 * tags a human applied by hand. Otherwise a one-character edit in Drive silently detaches the doc from
 * every notebook holding it and drops its tags.
 *
 * The delete's actor is the retired ROW'S OWN owner, not `connection.connectedBy` - a reconnect re-stamps
 * connectedBy (drive-sync.ts), and running as a non-owner would either deny (accumulating one orphan copy
 * per edit) or take deleteFabFile's self-unshare branch and mutate the file instead of reaping it.
 *
 * A genuine delete (gone from the folder) keeps the membership-only unpick and never deletes - the file left
 * the folder but the owner keeps their copy, which is not superseded by anything.
 *
 * OUT OF SCOPE for E1 (#1589 follow-ups): a rename/move in Drive (md5 unchanged, only modifiedTime
 * moves) is classified unchanged, so the stale fileName/relativePath is not reconciled; a
 * permanently-unsupported file (unsupported type, oversized Editors export) is never a durable member,
 * so it re-appears as a candidate and re-skips on every poll - noise, not harm, but it never converges;
 * and an unpicked file keeps its `driveConnectionId`/`sourceLakeId`, so one that leaves the folder and
 * later returns is re-ingested as a brand-new FabFile while the unpicked original lingers in the owner's
 * Files.
 *
 * Ordering is load-bearing. `storage.upload` fires `objectCreated` synchronously, which walks
 * objectCreated -> chunk -> vectorize; each stage advances batch progress by claiming its manifest
 * file (claimFileStatus). If the manifest entry does not exist yet those claims silently no-op, so
 * vectorizedFiles never increments and the batch never crosses its finalize threshold. Hence the
 * per-file `appendFiles` AHEAD of `storage.upload`, not a single append after the loop.
 *
 * totalFiles is seeded with the candidate count (adds + re-ingests); a skip (oversized / unsupported
 * / transient fetch error) is folded into `skippedFiles` as it happens, so `vectorized + failed +
 * skipped` still reaches totalFiles exactly (finalizeBatchIfComplete's gate) without the ingestable
 * count being known up front. Removals happen outside the batch (immediate lake-membership pulls).
 *
 * A folder too large for one invocation ingests across SEVERAL, as a chain of slices. The loop yields
 * on the Lambda deadline (INGEST_DEADLINE_BUFFER_MS) rather than being killed, then re-enqueues itself
 * carrying the batch it was filling. Three things make that converge where a plain SQS retry did not:
 *
 *   - The next slice ADOPTS the batch instead of creating one, and subtracts the Drive ids that batch
 *     has already UPLOADED or permanently skipped a FabFile for (findDriveFileIdsByBatchId,
 *     skippedDriveFileIds) from its own fresh walk. That subtraction is load-bearing and cannot be
 *     replaced by the ordinary diff: a file an earlier slice uploaded is still `pending` (so invisible
 *     to findByDriveConnectionIdInDataLake) and its superseded copy has already been retired, which
 *     makes it look like a brand-new ADD. Re-ingesting it is exactly the duplicate-tail spiral this
 *     chain exists to avoid.
 *   - The `syncing` claim is HANDED from slice to slice (renewSyncClaim -> adoptSyncClaim) and never
 *     returns to 'connected' in between, so the re-sync poll cannot slip in and start a competing walk
 *     mid-chain. The batch id names WHICH chain, but the actual CAS is a one-time `ingestClaimToken`
 *     rotated on every hand-off - the batch id alone cannot be consumed (it has to stay fixed for the
 *     whole chain to keep naming the same batch), so two deliveries of one continuation message would
 *     otherwise both match it and both adopt. The batch id is also what tells claimForSync's staleness
 *     arm to hold a chained claim for much longer than an unchained one - a continuation's un-refreshed
 *     interval is its queue wait, not its run length.
 *   - `totalFiles` is re-planned as the chain goes (raised when a later walk finds more, set exactly
 *     when the chain ends), so the finalize gate is still reached exactly and the batch never settles
 *     mid-chain or strands in `processing` afterwards.
 *
 * A throw part-way through a CONTINUATION slice is rethrown for SQS retry as before, and that retry
 * redelivers the same message - resumeBatchId included - so it adopts the batch and resumes instead of
 * re-creating the un-uploaded tail. The remaining gap is unchanged from #1589: a throw inside the FIRST
 * slice retries a message that names no batch, and can still duplicate what that slice had not uploaded.
 * Resuming that too would need the batch pointer to survive the claim release, which reopens the
 * stale-continuation race the claim token exists to close; the stuck-batch reconciler settles the
 * abandoned batch meanwhile.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  let connectionId: string | undefined;
  let claimed = false;
  try {
    const payload = Payload.parse(JSON.parse(event.Records[0].body));
    connectionId = payload.connectionId;
    const { redriveCount, resumeBatchId, slice } = payload;
    logger.updateMetadata({ handler: 'driveLakeIngest', connectionId });

    // The CAS token this run currently holds for the chain, if any - reassigned to the freshly
    // rotated value on a successful adopt, and again on every renewSyncClaim before a continuation
    // is enqueued. See OrgGoogleDriveConnection.ingestClaimToken for why the batch id alone can't
    // serve as this token.
    let ingestClaimToken = payload.claimToken;

    // `?? ` alone is not enough: a non-finite reading is not nullish and every comparison against it
    // is false, which would disable the deadline guard silently rather than fall back to the budget.
    const runStartedAt = Date.now();
    const remainingMs = () => {
      const reported = context?.getRemainingTimeInMillis?.();
      return typeof reported === 'number' && Number.isFinite(reported)
        ? reported
        : DEFAULT_RUN_BUDGET_MS - (Date.now() - runStartedAt);
    };

    const connection = await orgGoogleDriveConnectionRepository.findById(connectionId);
    if (!connection) {
      logger.warn('[driveLakeIngest] connection not found; dropping', { connectionId });
      return;
    }

    // Serialize ingest per connection: two rapid POSTs (a double-clicked button, a retried request)
    // both walk and both create a full set of FabFiles otherwise, since the driveFileId dedup can't
    // help while the first run's rows are still `pending`. The loser here is a cheap no-op.
    // A continuation takes over the claim its own previous slice is still holding, matched on the
    // batch id AND its one-time claim token, so the connection never passes through 'connected'
    // mid-chain, and a redelivered duplicate of THIS SAME continuation message (which presents the
    // same already-consumed token) loses rather than racing this run. Falling back to a fresh claim
    // covers the one case where the chain's claim is genuinely gone: the previous slice threw,
    // released, and SQS redelivered its message.
    claimed = false;
    if (resumeBatchId && ingestClaimToken) {
      const adopted = await orgGoogleDriveConnectionRepository.adoptSyncClaim(
        connectionId,
        resumeBatchId,
        ingestClaimToken
      );
      if (adopted) {
        claimed = true;
        ingestClaimToken = adopted;
      }
    }
    if (!claimed) claimed = await orgGoogleDriveConnectionRepository.claimForSync(connectionId);
    if (!claimed) {
      // Someone else holds the claim. If a real ingest is in flight ('syncing'), DEFER this run by
      // re-enqueuing with a delay so a genuine second sync (new files added mid-run) isn't dropped -
      // bounded so it can't spin. If instead the connection is in an error state (claimForSync won't
      // claim over one), there's nothing to defer behind, so just drop the duplicate.
      const current = await orgGoogleDriveConnectionRepository.findById(connectionId);
      if (current?.status === 'syncing' && redriveCount < MAX_INGEST_REDRIVES) {
        await sendToQueue(
          Resource.driveLakeIngestQueue.url,
          {
            connectionId,
            redriveCount: redriveCount + 1,
            // Forward the continuation's own identity, if this run had one: a continuation that
            // loses this race must not come back as a FRESH first-slice sync, which would carry no
            // resumeBatchId, subtract nothing, and re-ingest the chain's already-`pending` tail as
            // duplicate ADDs - the exact spiral chaining exists to prevent.
            ...(resumeBatchId && { resumeBatchId, slice, claimToken: payload.claimToken }),
          },
          INGEST_REDRIVE_DELAY_SECONDS
        );
        logger.info('[driveLakeIngest] another sync in flight; deferred', {
          connectionId,
          redriveCount: redriveCount + 1,
          resumeBatchId,
        });
      } else {
        logger.info('[driveLakeIngest] could not claim (not syncing or redrive exhausted); skipping', {
          connectionId,
          status: current?.status,
          redriveCount,
        });
      }
      return;
    }

    const lake = await dataLakeRepository.findById(connection.targetDataLakeId);
    if (!lake) {
      logger.warn('[driveLakeIngest] target data lake not found; dropping', { connectionId });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
      });
      return;
    }
    const user = await User.findById(connection.connectedBy);
    if (!user) {
      logger.warn('[driveLakeIngest] connecting user not found; dropping', { connectionId });
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
      });
      return;
    }
    const ability = defineAbilitiesFor(user as unknown as IUserDocument);

    // Prefer the connection's own token; falls back to the connecting user's (D not built yet).
    // A credential failure marks the connection credential_error and throws so SQS retries -> DLQ.
    const accessToken = await getValidConnectionDriveAccessToken(connectionId, connection.organizationId);
    const drive = createDriveClient(accessToken);

    // 1) Walk the folder tree (one level per Drive call, recursed). De-dup by driveFileId: a legacy
    //    multi-parented Drive file surfaces once per parent inside the walked subtree, and a duplicate
    //    would otherwise double-ingest (two FabFiles for one add) and double-remove (the second
    //    removeFileFromLake throws NotFoundError, aborting the reconcile mid-prune).
    const walkedRaw = await walkFolder(drive, connection.driveFolderId);
    const walkedIds = new Set<string>();
    const walked = walkedRaw.filter(f => {
      if (walkedIds.has(f.id)) return false;
      walkedIds.add(f.id);
      return true;
    });

    // 2) Diff the walk against everything THIS connection has in the lake, keyed by the stable
    //    driveFileId, and split into ADD (new), UPDATE (same id, moved md5/modifiedTime), and
    //    REMOVE (in the lake, gone from the folder). The stored set is the connection's own files
    //    so a re-sync never touches files added by other means.
    const datalakeTag = lake.datalakeTag;
    const existingDocs = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, datalakeTag);
    //    One driveFileId can map to SEVERAL stored copies: `main`'s add-only handler had no walk
    //    de-dup, so a multi-parented Drive file or an SQS retry after a partial run could already
    //    have created a second non-pending row. Key to a list (not last-wins) so those duplicates
    //    are visible here - otherwise they stay lake members holding pre-edit content that no
    //    future walk can ever see again.
    const existingByDriveId = new Map<string, (typeof existingDocs)[number][]>();
    for (const doc of existingDocs) {
      if (!doc.driveFileId) continue;
      const copies = existingByDriveId.get(doc.driveFileId);
      if (copies) copies.push(doc);
      else existingByDriveId.set(doc.driveFileId, [doc]);
    }
    // Newest-first within each id: the head anchors change detection (it is what the last successful
    // ingest wrote), and the tail is duplicates. Sorted rather than left in find() order so the
    // representative is deterministic - an unsorted query could otherwise diff against an older row
    // and re-ingest a file that is not actually stale.
    for (const copies of existingByDriveId.values()) {
      copies.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    const newestCopyOf = (driveFileId: string) => existingByDriveId.get(driveFileId)?.[0];
    const pureAdds = walked.filter(f => !existingByDriveId.has(f.id));
    const changed = walked.filter(f => {
      const prior = newestCopyOf(f.id);
      return prior != null && hasDriveFileChanged(prior, f);
    });
    let removed = existingDocs.filter(doc => doc.driveFileId != null && !walkedIds.has(doc.driveFileId));

    // Transient-glitch guard: an EMPTY walk while the lake still holds this connection's files is
    // far likelier a permission blip or a Drive hiccup than a real empty-out. walkFolder throws on a
    // listing error (so an empty result is a genuine "no children", not a truncated one), but
    // pruning an entire lake on one empty pass is too destructive to trust - refuse it. A real
    // empty-out still reconciles once even one file remains to anchor the walk as trustworthy.
    if (walked.length === 0 && existingDocs.length > 0) {
      logger.warn('[driveLakeIngest] folder walk returned empty while lake holds files; skipping prune', {
        connectionId,
        existing: existingDocs.length,
      });
      removed = [];
    }

    // The batch a previous slice of this chain was filling, if this run is a continuation of one. Only
    // adopted when it is still non-terminal and still belongs to this lake: the stuck-batch reconciler
    // may have settled it while the message waited, and appending to a settled batch would strand
    // manifest entries nothing will ever finalize. A rejected adoption is not fatal - the run simply
    // starts a fresh batch, which converges because the earlier slices' files are durable by then.
    const adoptedBatch = resumeBatchId
      ? await dataLakeBatchRepository.findById(resumeBatchId).then(prior => {
          if (!prior) return null;
          if (prior.dataLakeId !== connection.targetDataLakeId) return null;
          return BATCH_NON_TERMINAL_STATUSES.includes(prior.status) ? prior : null;
        })
      : null;
    if (resumeBatchId && !adoptedBatch) {
      logger.warn('[driveLakeIngest] continuation could not adopt its batch; starting a fresh one', {
        connectionId,
        resumeBatchId,
        slice,
      });
    }

    // Adds and edited files both ingest fresh; an edited file's stale copy is retired in the loop
    // below, only after its replacement is uploaded (never up front - see the header for why).
    //
    // On a continuation, subtract every driveFileId the adopted batch has already DEALT WITH - either
    // uploaded (still `pending`, its superseded copy already retired, so invisible to the diff above)
    // or permanently skipped (skip() mints no FabFile at all, so it is invisible the same way). Without
    // this every one of them reads as a fresh ADD and the chain would duplicate its own tail, or
    // re-fetch-and-re-skip a file that can never succeed - see the header and skip()'s own comment.
    const alreadyIngested = adoptedBatch
      ? new Set([
          ...(await fabFileRepository.findDriveFileIdsByBatchId(adoptedBatch.id)),
          ...(adoptedBatch.skippedDriveFileIds ?? []),
        ])
      : new Set<string>();
    const candidates = [...pureAdds, ...changed].filter(f => !alreadyIngested.has(f.id));

    // A trusted system reconcile acts as admin for membership writes (canManageLake): the connection
    // was authorized by an org owner/manager at connect time (verifyOrgAccess). Pass the resolved lake
    // itself (not a hand-projection) so `organizationId` reaches the org-manageable manage rung.
    const membershipActor = { userId: connection.connectedBy, isAdmin: true };
    const recomputeStats = () =>
      dataLakeService.recomputeLakeStats(lake, {
        db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
      });

    // Bytes reclaimed by the full deletes below, accumulated PER OWNER: after a reconnect the copies
    // one run retires can belong to more than one user (see retireSupersededCopy), and each one's
    // quota has to be given back to the right document.
    const reclaimedBytesByUserId = new Map<string, number>();

    // Every lake whose PREFIX arm could reach a file owned by anyone in this connection's stored set,
    // or by whoever is connected now. Memoized: resolved ONCE for the whole run rather than per retire,
    // and not at all on a run that retires nothing - the common poll outcome. Membership is still
    // re-asserted per lake, per owner, inside findOtherLakeClaims.
    let candidateLakesOnce: ReturnType<typeof dataLakeService.loadPrefixArmCandidateLakes> | undefined;
    const prefixArmCandidateLakes = () =>
      (candidateLakesOnce ??= dataLakeService.loadPrefixArmCandidateLakes(
        [connection.connectedBy, ...existingDocs.map(doc => doc.userId)],
        { db: { dataLakes: dataLakeRepository } }
      ));

    // deleteFabFile throws when its actor no longer exists, which would fail the whole reconcile on a
    // deterministic condition (an owner deleted since ingest) - retried to the DLQ, never converging.
    // Resolve once per owner and skip that copy instead.
    const ownerExists = new Map<string, boolean>();
    const ownerStillExists = async (ownerId: string) => {
      const cached = ownerExists.get(ownerId);
      if (cached !== undefined) return cached;
      const exists = !!(await userRepository.findById(ownerId));
      ownerExists.set(ownerId, exists);
      return exists;
    };

    /**
     * Move what the hard delete is about to destroy onto the fresh copy superseding it: the notebook
     * attachments (deleteFabFile strips the retired id from every session's `knowledgeIds`) and the
     * tags a human applied by hand (the replacement is minted with this lake's tags only).
     *
     * Only ever called on the delete branch. On the unpicked branch the retired copy keeps living
     * with its links and tags intact, so there is nothing to carry - and attaching the replacement
     * alongside it would put the same document in a notebook twice.
     */
    const carryForwardToReplacement = async (
      retiredCopy: (typeof existingDocs)[number],
      replacementFabFileId: string
    ) => {
      // Link the replacement BEFORE the delete unlinks the stale id: deleteFabFile filters only the
      // retired id out of `knowledgeIds`, so an entry appended here survives that same write.
      const attached = await sessionRepository.findAllWithKnowledgeId(retiredCopy.id);
      for (const notebook of attached) {
        const knowledgeIds = notebook.knowledgeIds ?? [];
        if (knowledgeIds.includes(replacementFabFileId)) continue;
        await sessionRepository.update({ id: notebook.id, knowledgeIds: [...knowledgeIds, replacementFabFileId] });
      }

      // A meta-tag is membership, not content: this lake's was just pulled, the gate proved no other
      // lake holds one, and a non-canonical leftover names no lake at all. None of them carry over.
      //
      // Nor may a carried tag enrol the REPLACEMENT in a lake of its own. The gate cleared the
      // RETIRED copy's owner, and after a reconnect the replacement's owner differs (it is minted as
      // connection.connectedBy), so a tag that conferred nothing there can still match a prefix arm
      // of a lake the new owner created. Dropping those keeps this a pure carry-over, and keeps it
      // out of the membership doors (reconcileLakeTags) a real join would have to go through.
      const replacementOwnerLakes = (await prefixArmCandidateLakes()).filter(
        candidate => candidate.createdByUserId === connection.connectedBy
      );
      const carried: { name: string; strength: number }[] = [];
      for (const tag of retiredCopy.tags ?? []) {
        const name = tag?.name;
        if (typeof name !== 'string' || isDataLakeTagName(name)) continue;
        if (replacementOwnerLakes.some(candidate => matchesTagPrefixArm([name], candidate.fileTagPrefix))) continue;
        carried.push({ name, strength: typeof tag.strength === 'number' ? tag.strength : 0 });
      }
      // Grouped because pushTagsByFabFileId applies ONE strength per call, and a carried tag keeps
      // the strength a human gave it rather than being flattened to the default.
      const namesByStrength = new Map<number, string[]>();
      for (const { name, strength } of carried) {
        const names = namesByStrength.get(strength);
        if (names) names.push(name);
        else namesByStrength.set(strength, [name]);
      }
      for (const [strength, names] of namesByStrength) {
        await fabFileRepository.pushTagsByFabFileId(replacementFabFileId, names, strength);
      }
    };

    /**
     * Retire a superseded copy of a Drive file: unpick it from THIS lake, then delete it outright
     * only when nothing else claims it - no other lake under either membership arm, and no share
     * granting a reader other than its owner. `replacementFabFileId`
     * is the fresh copy that supersedes this one, and inherits its links and tags. The header covers
     * why the two steps cannot collapse into one soft-delete, why both arms have to be tested, and
     * why the actor is the row's own owner. Returns what it did, for the log.
     */
    const retireSupersededCopy = async (staleCopy: (typeof existingDocs)[number], replacementFabFileId: string) => {
      // Per-lake by construction: clears this lake's meta-tag and prefixed content tags, nothing else.
      await dataLakeService.removeFileFromLake(membershipActor, lake, staleCopy.id, {
        db: { fabFiles: fabFileRepository },
      });

      // Re-read AFTER the unpick, so the gate runs against the tags that actually SURVIVE it. The
      // question a hard delete must answer is "now that this file has left THIS lake, does any other
      // lake still hold it", and only the stored document answers that without re-deriving which
      // signals removeFileFromLake chose to pull.
      const retiredCopy = await fabFileRepository.findById(staleCopy.id);
      if (!retiredCopy) {
        logger.warn('[driveLakeIngest] superseded copy vanished before retire; unpicked only', {
          fabFileId: staleCopy.id,
        });
        return 'unpicked' as const;
      }

      // A grant to anyone other than the owner is a claim too, and the same argument the other-lake
      // branch makes below applies: the delete is global, so it would take the share vector with it
      // and leave the sharee holding a notebook reference they can no longer resolve - silently,
      // because getAccessibleFiles just drops an id the reader has no grant on. The replacement
      // carries no shares (it is minted for connection.connectedBy alone), so there is nothing to
      // hand them instead. Keep the retired copy alive and merely unpicked: the sharee sees the
      // PRE-EDIT content, which they can re-request, rather than losing the file outright.
      const shareClaims = {
        users: (retiredCopy.users ?? []).length,
        groups: (retiredCopy.groups ?? []).length,
        globalRead: !!retiredCopy.isGlobalRead,
      };
      if (shareClaims.users > 0 || shareClaims.groups > 0 || shareClaims.globalRead) {
        logger.info('[driveLakeIngest] superseded copy is shared outside its owner; unpicked only', {
          fabFileId: staleCopy.id,
          ...shareClaims,
        });
        return 'unpicked' as const;
      }

      const tagNames = (retiredCopy.tags ?? [])
        .map(tag => tag?.name)
        .filter((name): name is string => typeof name === 'string');

      const claims = await dataLakeService.findOtherLakeClaims({ userId: retiredCopy.userId, tagNames }, lake, {
        db: { dataLakes: dataLakeRepository },
        candidateLakes: await prefixArmCandidateLakes(),
      });
      if (dataLakeService.hasOtherLakeClaim(claims)) {
        // Someone curated this file into another lake - by that lake's meta-tag, or by a tag under
        // its fileTagPrefix. It leaves the Drive lake and keeps living there; deleting it would evict
        // it from a lake this poll has no business touching. The consequence, deliberately: that lake
        // keeps the PRE-EDIT copy, because the fresh replacement is tagged into this lake only.
        // Propagating an edit into a hand-curated lake is a decision for whoever curated it, not for
        // a background poll - and holding stale content is recoverable (re-add the new copy), whereas
        // a silent eviction is not.
        logger.info('[driveLakeIngest] superseded copy belongs to another lake; unpicked only', {
          fabFileId: staleCopy.id,
          otherLakeTags: claims.metaTagNames,
          otherLakeIds: claims.prefixArmLakes.map(other => other.id),
        });
        return 'unpicked' as const;
      }

      const ownerId = retiredCopy.userId;
      if (!ownerId || !(await ownerStillExists(ownerId))) {
        logger.warn('[driveLakeIngest] superseded copy has no living owner; left unpicked', {
          fabFileId: staleCopy.id,
          ownerId,
        });
        return 'unpicked' as const;
      }

      await carryForwardToReplacement(retiredCopy, replacementFabFileId);

      // Sole-lake copy: delete for real, so the chunks, search-index docs, notebook links, S3 object
      // and storage quota go with it.
      const { action } = await fabFilesService.deleteFabFile(
        ownerId,
        { id: staleCopy.id },
        {
          db: {
            fabFiles: fabFileRepository,
            fabFileChunks: fabFileChunkRepository,
            users: userRepository,
            sessions: sessionRepository,
          },
          storage: getFilesStorage(),
          onDeleteComplete: async (_fabFile, size) => {
            reclaimedBytesByUserId.set(ownerId, (reclaimedBytesByUserId.get(ownerId) ?? 0) + size);
          },
          searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
        }
      );
      if (action !== 'deleted') {
        logger.warn('[driveLakeIngest] superseded copy could not be deleted; left unpicked', {
          fabFileId: staleCopy.id,
          action,
        });
      }
      return action;
    };

    // Best-effort, and deliberately non-fatal: the files are already gone, so a failed quota write
    // must not throw the whole reconcile into an SQS retry that would re-walk and re-ingest.
    const flushReclaimedStorage = async () => {
      if (reclaimedBytesByUserId.size === 0) return;
      // Drain before deducting: this also runs from a `finally`, and a partial failure must not leave
      // bytes staged for a later flush to deduct a second time.
      const pending = [...reclaimedBytesByUserId.entries()];
      reclaimedBytesByUserId.clear();
      for (const [ownerId, bytes] of pending) {
        if (bytes <= 0) continue;
        try {
          // Load the owner HERE, never the document read at the top of this handler. changeStorageSize
          // mutates in memory and save() writes an ABSOLUTE currentStorageSize, so a document read
          // before the loop would overwrite the increments every storage.upload in it just made
          // through objectCreated - which loads and saves its own copy of the same user. Same reason
          // bulk-delete.ts re-reads immediately before deducting; the transaction makes this
          // read-modify-write conflict-checked rather than merely narrow.
          await withTransaction(async () => {
            const owner = await User.findById(ownerId);
            if (!owner) return;
            await changeStorageSize(owner, -bytes);
            await owner.save();
          });
        } catch (e) {
          logger.error('[driveLakeIngest] failed to deduct reclaimed storage', {
            connectionId,
            ownerId,
            bytes,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };

    /**
     * Close out the batch a chain shares across its slices: re-plan `totalFiles` to what the chain
     * ACTUALLY produced (manifest entries + skips) and nudge the finalize gate. A chain plans that
     * total a slice at a time - the first from its own candidate list, later ones raising it as the
     * folder grows - so a chain that ends having ingested fewer files than planned would otherwise sit
     * in `processing` until the stuck-batch reconciler force-failed it.
     */
    const settleChainedBatch = async (batchId: string) => {
      const current = await dataLakeBatchRepository.findById(batchId);
      if (!current) return;
      const produced = (current.files?.length ?? 0) + (current.skippedFiles ?? 0);
      const settled =
        produced === current.totalFiles
          ? current
          : await dataLakeBatchRepository.setTotalFilesIfActive(batchId, produced);
      await finalizeBatchIfComplete(settled ?? current, logger);
    };

    // 3) Enforce the candidate cap FIRST, before any membership write. It bounds the un-sliceable
    //    walk+diff every slice has to redo (see MAX_INGEST_CANDIDATES), so it is a deterministic refusal
    //    - return cleanly rather than DLQ-ing a retry - and refusing here guarantees nothing is changed
    //    on a run that cannot ingest, not even an early removal that would strand files.
    if (candidates.length > MAX_INGEST_CANDIDATES) {
      logger.warn('[driveLakeIngest] folder exceeds the ingest candidate cap; refusing', {
        connectionId,
        candidates: candidates.length,
        cap: MAX_INGEST_CANDIDATES,
      });
      // A folder that grew past the cap mid-chain still owes its adopted batch a settlement - the
      // same exit this cap refusal shares with the zero-candidate and admission-refusal returns below.
      if (adoptedBatch) await settleChainedBatch(adoptedBatch.id);
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
        lastError: `Folder has ${candidates.length} files to sync (new + re-synced), over the ${MAX_INGEST_CANDIDATES}-file limit for one sync. Split it into subfolders and connect them separately.`,
      });
      return;
    }

    // 4) Apply genuine deletes now: a file gone from the folder has no replacement pending, so the
    //    membership-only unpick loses nothing (the FabFile stays in the owner's Files, chunks untouched).
    //    Stats recompute is deferred to the end so it also reflects the stale copies retired in the loop.
    for (const doc of removed) {
      await dataLakeService.removeFileFromLake(membershipActor, lake, doc.id, {
        db: { fabFiles: fabFileRepository },
      });
    }

    let retired = 0;

    // Everything that retires a copy runs inside this `try`, step 4b included, so that a throw part
    // way through EITHER the duplicate sweep or the ingest loop still settles what the committed
    // deletes changed: the reclaimed bytes (the retry re-walks without seeing those files, so they
    // would stay counted against their owners forever) and the lake's stats.
    try {
      // 4b) Retire pre-existing duplicates: extra copies of a driveFileId that is STILL in the folder,
      //     left behind by the add-only handler this replaced (a multi-parented file, or an SQS retry
      //     after a partial run). They hold pre-edit content, stay lake members, and are invisible to
      //     every future walk because the newest copy shadows them. Safe to retire up front and not
      //     after an upload: the newest copy stays live either way, so nothing is left without a member.
      //     A driveFileId gone from the folder is skipped here - all of its copies are already in
      //     `removed` above.
      for (const [driveFileId, copies] of existingByDriveId) {
        if (!walkedIds.has(driveFileId) || copies.length < 2) continue;
        //   The newest copy is what supersedes every duplicate, so it inherits their notebook links
        //   and tags. If this driveFileId is ALSO an edit, the loop below carries that chain onward
        //   from the newest copy to the fresh upload.
        for (const duplicate of copies.slice(1)) {
          await retireSupersededCopy(duplicate, copies[0].id);
          retired++;
        }
      }

      if (candidates.length === 0) {
        logger.info('[driveLakeIngest] reconciled; no files to ingest', {
          walked: walked.length,
          existing: existingDocs.length,
          removed: removed.length,
          updated: changed.length,
          retired,
        });
        // A chain whose last slice happened to consume the remainder exactly lands here, with its
        // batch still open on the previous slice's plan. Settle it rather than leaving it processing.
        if (adoptedBatch) await settleChainedBatch(adoptedBatch.id);
        await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
          status: 'connected',
          lastPolledAt: new Date(),
        });
        return;
      }

      // The admission contract (#1680) for the lake this sync is JOINING every candidate into. This
      // door resolves its lake server-side and stamps the meta-tag itself (below), and it creates its
      // FabFiles through the manager's direct `FabFile.create` rather than
      // `fabFileService.createFabFile` - so neither the meta-tag chokepoint nor the service gate ever
      // sees it. Structurally the same unwired door `generate-presigned-urls-batch` needed its own
      // explicit call for.
      //
      // Once per sync, before the batch: the lake and the owner-to-be are the same for every
      // candidate, so a refusal is a property of the connection, not of any one file. No FabFile
      // exists yet, so the subject is the owner-to-be and the gate predicts from THEIR chunk policy.
      // It sits after the reconcile's removals on purpose - a file gone from the folder is retired
      // whether or not the lake will accept new content, exactly as on the zero-candidate return.
      //
      // A refusal is DETERMINISTIC - retrying re-reads the same lever and the same policy - so it is
      // recorded as guidance and returned cleanly rather than rethrown into an SQS retry that would
      // spin to the DLQ. Same treatment as the candidate cap above.
      try {
        await dataLakeService.assertLakeAdmission([lake], [{ userId: connection.connectedBy }], {
          db: { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
          logger,
        });
      } catch (admissionError) {
        if (!(admissionError instanceof BadRequestError)) throw admissionError;
        logger.warn('[driveLakeIngest] data lake refused this content at admission; refusing the sync', {
          connectionId,
          dataLakeId: lake.id,
          candidates: candidates.length,
        });
        // A lever flipped mid-chain refuses the remainder; the slices already ingested still have to
        // settle their shared batch rather than leave it processing.
        if (adoptedBatch) await settleChainedBatch(adoptedBatch.id);
        await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
          status: 'connected',
          lastPolledAt: new Date(),
          lastError: admissionError.message,
        });
        return;
      }

      // 5) Adopt this chain's batch, or create one. totalFiles is the candidate count; a per-file skip
      //    is folded into skippedFiles as it happens (see the loop below), so the finalize gate is still
      //    reached exactly. totalSizeBytes is best-effort - Google Editors files carry no size at list time.
      //
      //    On adoption the plan is RAISED, never lowered: a later slice re-walks a folder that may have
      //    gained files, and letting the recorded total fall behind what this chain will actually produce
      //    would let the gate fire mid-chain and finalize a batch still being appended to. The exact set
      //    happens once, when the chain ends (settleChainedBatch).
      const batch =
        adoptedBatch ??
        (await dataLakeBatchRepository.create({
          dataLakeId: connection.targetDataLakeId,
          userId: connection.connectedBy,
          status: 'processing',
          conflictResolution: 'skip',
          totalFiles: candidates.length,
          totalSizeBytes: candidates.reduce((sum, f) => sum + (f.size ?? 0), 0),
          uploadedFiles: 0,
          chunkedFiles: 0,
          vectorizedFiles: 0,
          failedFiles: 0,
          processingFailedFiles: 0,
          skippedFiles: 0,
          uploadedSizeBytes: 0,
          files: [],
          appliedTags: [],
          startedAt: new Date(),
          wantsTaxonomy: false,
          taxonomyStatus: 'none',
        }));

      if (adoptedBatch) {
        // alreadyIngested already includes every driveFileId this chain has uploaded OR permanently
        // skipped (see how it's built above), so it alone covers what earlier slices produced -
        // adding adoptedBatch.skippedFiles on top would double-count them.
        const planned = alreadyIngested.size + candidates.length;
        if (planned > adoptedBatch.totalFiles) {
          await dataLakeBatchRepository.setTotalFilesIfActive(adoptedBatch.id, planned);
        }
      }

      const applyFallbackTags = dataLakeService.createDataLakeFallbackTagger({
        db: { dataLakes: dataLakeRepository },
        logger,
      });
      const storage = getFilesStorage();
      let uploaded = 0;
      let skipped = 0;

      // Idempotent per driveFileId within this chain (recordSkippedDriveFile), so a file that keeps
      // failing the same deterministic gate on every slice (see skip()'s own callers) is counted and
      // subtracted exactly once instead of once per slice.
      const skip = async (driveFileId: string, reason: string, extra?: Record<string, unknown>) => {
        const recorded = await dataLakeBatchRepository.recordSkippedDriveFile(batch.id, driveFileId);
        if (recorded) skipped++;
        logger.info('[driveLakeIngest] skipping file', { driveFileId, reason, recorded, ...extra });
      };

      // 6) One file at a time: size-gate -> fetch -> create FabFile -> append its manifest entry ->
      //    upload. Only one file's bytes are ever live, and the manifest entry precedes the upload so
      //    the objectCreated/chunk/vectorize claims the upload fires can find it (see header).
      let deferred = 0;
      for (const [index, file] of candidates.entries()) {
        // Yield rather than get killed, checked BEFORE starting a file so the run never dies between
        // creating a FabFile and uploading its bytes. `index > 0` guarantees every slice makes at
        // least one file of progress, so a chain can never spend its whole slice budget doing nothing.
        if (index > 0 && remainingMs() < INGEST_DEADLINE_BUFFER_MS) {
          deferred = candidates.length - index;
          break;
        }

        // Native binaries carry a size, so skip the oversized ones BEFORE spending a Drive download.
        // Editors exports have no size here; they are bounded by Drive's own ~10 MB export cap
        // (surfaced as export_too_large) plus the post-fetch guard below.
        if (file.size != null && file.size > MAX_INGEST_FILE_BYTES) {
          await skip(file.id, 'oversized', { size: file.size });
          continue;
        }

        const result = await fetchDriveFileContent(drive, file);
        if (!result.ok) {
          await skip(file.id, result.reason);
          continue;
        }
        if (result.bytes.length > MAX_INGEST_FILE_BYTES) {
          await skip(file.id, 'oversized_after_fetch', { size: result.bytes.length });
          continue;
        }

        const { bytes, mimeType } = result;
        const ext = mime.extension(mimeType);
        const fileKey = `${uuidv4()}${ext ? `.${ext}` : ''}`;
        const tags = await applyFallbackTags([{ name: datalakeTag, strength: DATALAKE_TAG_STRENGTH }]);

        const fabFile = await createFabFile(
          {
            userId: connection.connectedBy,
            filePath: fileKey,
            fileSize: bytes.length,
            fileName: file.name,
            mimeType,
            type: KnowledgeType.FILE,
            tags,
            batchId: batch.id,
            relativePath: file.relativePath,
            status: 'pending',
            // Drive provenance (#1589): dedup key + change detection + source.
            sourceType: FabFileSourceType.GOOGLE_DRIVE,
            driveFileId: file.id,
            ...(file.modifiedTime && { driveModifiedTime: new Date(file.modifiedTime) }),
            ...(file.md5Checksum && { driveMd5Checksum: file.md5Checksum }),
            sourceLakeId: connection.targetDataLakeId,
            driveConnectionId: connectionId,
          },
          ability
        );

        // Manifest entry BEFORE the bytes land - the upload fires objectCreated synchronously and its
        // downstream claims need this entry to already exist (ordering is load-bearing; see header).
        await dataLakeBatchRepository.appendFiles(batch.id, [
          {
            fabFileId: fabFile.id,
            fileName: file.name,
            relativePath: file.relativePath,
            status: 'pending',
          },
        ]);

        await storage.upload(bytes, fileKey, { ContentType: mimeType });
        uploaded++;

        // Confirm the upload SYNCHRONOUSLY, right here - not left to the async S3 objectCreated
        // event. findDriveFileIdsByBatchId (what a resumed slice subtracts) excludes 'pending' rows
        // precisely so a FabFile whose storage.upload threw is not mistaken for an uploaded one; a
        // continuation enqueued moments after this call cannot be trusted to race that event first.
        await fabFileRepository.markUploaded(fabFile.id);

        // Edited file: its fresh replacement is now durably uploaded, so retire the superseded copy
        // (see retireSupersededCopy, and the header for the invariants it keeps). Done PER-FILE right
        // after the upload, not batched at the end: a later file throwing then leaves every
        // already-processed edit fully reconciled (old retired, new uploaded) instead of stranding the
        // old copy as a duplicate lake member the next walk can no longer see (both share
        // driveFileId). Only the newest copy is left to retire here - any older siblings went in 4b.
        const staleCopy = newestCopyOf(file.id);
        if (staleCopy) {
          await retireSupersededCopy(staleCopy, fabFile.id);
          retired++;
        }
      }

      logger.info('[driveLakeIngest] uploaded; pipeline will chunk+vectorize', {
        connectionId,
        batchId: batch.id,
        slice,
        walked: walked.length,
        existing: existingDocs.length,
        removed: removed.length,
        updated: changed.length,
        uploaded,
        skipped,
        deferred,
        retired,
      });

      // 7) Out of time with files left: hand the claim and the batch to another slice rather than
      //    finishing here. The claim is renewed (never released) so the connection stays 'syncing' and
      //    no poll can start a competing walk in the gap, and the batch stays open so the next slice
      //    appends to it instead of starting a second one.
      if (deferred > 0 && slice + 1 < MAX_INGEST_SLICES) {
        const renewedToken = await orgGoogleDriveConnectionRepository.renewSyncClaim(connectionId, batch.id);
        if (renewedToken) {
          await sendToQueue(Resource.driveLakeIngestQueue.url, {
            connectionId,
            resumeBatchId: batch.id,
            slice: slice + 1,
            claimToken: renewedToken,
          });
          logger.info('[driveLakeIngest] out of time; enqueued continuation slice', {
            connectionId,
            batchId: batch.id,
            slice: slice + 1,
            deferred,
          });
          // Deliberately NOT releasing the claim, and NOT finalizing: the chain owns both until it ends.
          return;
        }
        // The claim went while this slice ran (a stale-claim reclaim, a disconnect). Someone else owns
        // the connection now: settle the batch, but touch NOTHING on the connection - healing it to
        // 'connected' here would release a claim this run no longer holds.
        logger.warn('[driveLakeIngest] lost the sync claim mid-slice; ending the chain', {
          connectionId,
          batchId: batch.id,
          slice,
          deferred,
        });
        claimed = false;
        await settleChainedBatch(batch.id);
        return;
      } else if (deferred > 0) {
        // Chain ceiling. Coverage is not lost - the files this chain uploaded stop being candidates
        // once they vectorize, so the next scheduled poll picks the remainder up in a fresh chain.
        logger.warn('[driveLakeIngest] continuation chain hit the slice ceiling; stopping', {
          connectionId,
          batchId: batch.id,
          slice,
          deferred,
          maxSlices: MAX_INGEST_SLICES,
        });
      }

      // A batch that only skipped (or whose uploads all vectorized before the loop ended) has already
      // crossed the finalize gate, but nothing re-checks it - our skip increments don't fire the
      // pipeline's finalize. Nudge it once; a guarded no-op if uploads are still in flight. A chained
      // batch is re-planned to what the chain actually produced first (see settleChainedBatch),
      // because its recorded total is a plan made slice by slice, not a count.
      if (adoptedBatch || deferred > 0) await settleChainedBatch(batch.id);
      else await finalizeBatchIfComplete(await dataLakeBatchRepository.findById(batch.id), logger);

      // Releases the syncing claim (syncing -> connected).
      await orgGoogleDriveConnectionRepository.updateHealth(connectionId, {
        status: 'connected',
        lastPolledAt: new Date(),
        ...(deferred > 0 && {
          lastError: `Sync stopped after ${MAX_INGEST_SLICES} continuation runs with ${deferred} files left. The next scheduled poll continues from here; split very large folders into subfolders to converge faster.`,
        }),
      });
    } finally {
      await flushReclaimedStorage();

      // Recompute for every membership change this run made - the genuine deletes above and every
      // copy retired since. In the `finally` because a mid-loop throw is rethrown for SQS retry, and
      // the retry re-walks a folder whose removals and retires are ALREADY applied: it finds nothing
      // to do and skips the recompute too, leaving fileCount/totalSizeBytes overstated until some
      // unrelated write happens to fix them. Swallowed like the flush above, and because a throw
      // raised here would replace the original error on its way to SQS.
      //
      // The freshly-uploaded replacements are still 'pending' and excluded from the stats aggregate
      // until the pipeline vectorizes them and finalizeBatchIfComplete recomputes again, exactly as a
      // plain add already does.
      if (removed.length > 0 || retired > 0) {
        await recomputeStats().catch(e =>
          logger.error('[driveLakeIngest] failed to recompute lake stats', {
            connectionId,
            error: e instanceof Error ? e.message : String(e),
          })
        );
      }
    }
  } catch (err) {
    // Release the syncing claim so a retry can re-run - guarded so it can't clobber a
    // credential_error that getValidConnectionDriveAccessToken set underneath us. Carry the failure
    // onto `lastError`: the release heals the status back to 'connected' and stamps lastPolledAt, so
    // without this a deterministically-broken connection reads healthy and freshly-polled with no
    // operator-visible sign that every sync is dying.
    if (claimed && connectionId) {
      await orgGoogleDriveConnectionRepository
        .releaseSyncClaim(connectionId, err instanceof Error ? err.message : String(err))
        .catch(e =>
          logger.error(`[driveLakeIngest] failed to release sync claim: ${e instanceof Error ? e.message : String(e)}`)
        );
    }
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping drive-lake-ingest message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB / network / Drive - let SQS retry, then DLQ.
  }
});
