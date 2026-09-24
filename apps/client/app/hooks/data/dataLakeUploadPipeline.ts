import {
  folderTagForFile,
  isSupportedFabFileMimeType,
  hasBlankTagPrefixSegment,
  submittedTagPrefix,
  MAX_TAG_PREFIX_LENGTH,
  MIN_TAG_PREFIX_LENGTH,
} from '@bike4mind/common';
import type { CreateDataLakeRequestInputType, UpdateDataLakeRequestInputType } from '@bike4mind/common';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import type {
  DataLakeFormValues,
  PendingDriveFolder,
  RecoverableLake,
  UploadErrorKind,
  UploadProgress,
  WizardStep,
} from '@client/app/stores/useDataLakeWizardStore';
import { MIN_DATA_LAKE_SLUG_LENGTH } from '@bike4mind/common';
import { slugifyDataLakeName } from '@client/app/hooks/data/dataLakeSlug';
import { uploadFileToUrl } from '@client/app/utils/uploadFileToUrl';
import { api } from '@client/app/contexts/ApiContext';
import { activeOrgId } from '@client/app/hooks/data/dataLakes';
import { toast } from 'sonner';
import axios from 'axios';

/** Union of every file's folder tag, for the batch record's appliedTags summary. AI-suggested
 * category tags are no longer part of this - they're applied later, post-upload. */
export function foldersTagsForBatch(
  files: { relativePath: string }[],
  tagPrefix: string
): { name: string; strength: number }[] {
  const byName = new Map<string, number>();
  for (const f of files) {
    for (const tag of folderTagForFile(f.relativePath, tagPrefix)) {
      byName.set(tag.name, tag.strength);
    }
  }
  return Array.from(byName, ([name, strength]) => ({ name, strength }));
}

// -- Constants -----------------------------------------------------------------

const UPLOAD_CONCURRENCY = 5;
const BATCH_CHUNK_SIZE = 100; // Max files per presigned URL request

/**
 * Canonical offline message. Shared by the mutation's pre-flight guard, the error
 * classifier, and DataLakeWizardModal's pre-flight check so all offline entry points
 * say the same thing.
 */
export const OFFLINE_MESSAGE = 'No internet connection. Check your network and try again.';
// Every file's upload PUT failed even though the lake/batch were created - a transport
// problem (network, CSP blocking the presigned host), not the user's lake settings.
export const UPLOAD_ALL_FAILED_MESSAGE =
  'None of the files could be uploaded. This is usually a network or connection issue, not your data lake settings. Please try again.';

/**
 * Translate an upload/create failure into a distinct kind + human message. The lake
 * config validates server-side with zod, whose raw text (e.g. "Too small: expected
 * string to have >=2 characters at 'slug'") must never reach the UI - so a 422 is
 * re-derived here from the config against the same rules to name the real culprit.
 * Both the prefix thresholds and the slug bound come from the same constants the schema
 * validates against, so this translator cannot name a limit the server does not enforce.
 * `snapshot` is the config/isAppend state the caller read when classifying - same store,
 * same tick as the old inline read (store reads don't belong in this pure module).
 */
export function classifyUploadError(
  error: unknown,
  snapshot: { config: { name: string; tagPrefix: string }; isAppend: boolean }
): { kind: UploadErrorKind; message: string } {
  // Network / offline: the request never reached the server, so there's no response body.
  // Covers both the axios transport error and the pre-flight guard's thrown OFFLINE_MESSAGE.
  const isNetworkError =
    (axios.isAxiosError(error) && (error.code === 'ERR_NETWORK' || error.message === 'Network Error')) ||
    (error instanceof Error && error.message === OFFLINE_MESSAGE);
  if (isNetworkError) {
    return { kind: 'network', message: OFFLINE_MESSAGE };
  }

  // All uploads failed (thrown by the batch flow after the lake/batch were rolled back):
  // a transport problem, not a config/validation one.
  if (error instanceof Error && error.message === UPLOAD_ALL_FAILED_MESSAGE) {
    return { kind: 'upload', message: UPLOAD_ALL_FAILED_MESSAGE };
  }

  const status = axios.isAxiosError(error) ? error.response?.status : undefined;

  // 422: the lake name/tag prefix was rejected. Re-derive the culprit from the config
  // rather than surfacing the raw validator string.
  if (status === 422) {
    const { config, isAppend } = snapshot;
    // Only create mode submits a name and prefix; append mode locks both, so neither can be
    // what the server rejected there - fall through to the neutral message instead.
    if (!isAppend) {
      if (slugifyDataLakeName(config.name).length < MIN_DATA_LAKE_SLUG_LENGTH) {
        return {
          kind: 'validation',
          message: `The data lake name is too short. Use a name with at least ${MIN_DATA_LAKE_SLUG_LENGTH} letters or numbers.`,
        };
      }
      const prefix = submittedTagPrefix(config.tagPrefix);
      if (prefix.length < MIN_TAG_PREFIX_LENGTH) {
        return {
          kind: 'validation',
          message: `The tag prefix is too short. Use at least ${MIN_TAG_PREFIX_LENGTH} characters ending in ":" (e.g. "legal:").`,
        };
      }
      // Start Upload gates on this same bound, applied to this same submitted form, so the
      // wizard should never get here - kept so a prefix arriving by any other route still
      // names itself rather than falling through to the neutral message below.
      if (prefix.length > MAX_TAG_PREFIX_LENGTH) {
        return {
          kind: 'validation',
          message: `The tag prefix is too long. Use ${MAX_TAG_PREFIX_LENGTH} characters or fewer, including the trailing ":".`,
        };
      }
      if (hasBlankTagPrefixSegment(prefix)) {
        return {
          kind: 'validation',
          message:
            'The tag prefix has a blank ":" segment. Give every segment a visible character (e.g. "legal:" or "legal:contracts:").',
        };
      }
    }
    // Neutral fallback: a 422 can also come from the batch/presigned-URL endpoints or
    // requiredEntitlement, and in append mode the Config fields are locked - so don't
    // claim the name/tag prefix is the culprit when we couldn't confirm it.
    return {
      kind: 'validation',
      message: 'Your data lake settings were rejected. Review them and try again.',
    };
  }

  if (status !== undefined && status >= 500) {
    return { kind: 'server', message: 'The server ran into a problem. Please try again in a moment.' };
  }

  // Other 4xx (403 feature gate, 404, 409, 429, ...) carry a curated server message worth
  // showing. Safe to surface: errorHandler maps every ZodError to a 422, handled above, so
  // no validator text can reach here.
  if (status !== undefined && status >= 400) {
    const data = axios.isAxiosError(error) ? (error.response?.data as Record<string, unknown> | undefined) : undefined;
    const serverMessage = typeof data?.error === 'string' ? data.error : undefined;
    const fallbackMessage = typeof data?.message === 'string' ? data.message : undefined;
    return {
      kind: 'server',
      message: serverMessage || fallbackMessage || 'The request was rejected. Please try again.',
    };
  }

  // Locally-thrown guard errors (e.g. "No files to upload") already carry a friendly message.
  if (error instanceof Error && error.message) {
    return { kind: 'unknown', message: error.message };
  }

  return { kind: 'unknown', message: 'Batch upload failed. Please try again.' };
}

/**
 * Zeroed progress counters for a fresh commit attempt. `totalFiles` is left at 0 for the caller
 * that knows the real count to override - the fileless Drive commit genuinely has none.
 */
export function zeroProgressCounts(): Partial<UploadProgress> {
  return {
    totalFiles: 0,
    uploadedFiles: 0,
    chunkedFiles: 0,
    vectorizedFiles: 0,
    failedFiles: 0,
    failedFileNames: [],
    processingFailedFiles: 0,
  };
}

/**
 * Create the lake the wizard is configuring (create mode only). Shared by both commit paths - the
 * batch upload and the fileless Drive-only create (useCreateLakeFromDrive) - so a lake is born from
 * exactly the same fields either way.
 *
 * `tagPrefix` is passed in rather than derived here: it is the value every client-side gate already
 * judged (see submittedTagPrefix), and re-deriving it would let the two drift.
 */
export async function createWizardLake(config: DataLakeFormValues, tagPrefix: string): Promise<string> {
  // Scope to the active account-switcher org (Personal -> undefined). activeOrgId reads the store
  // at call time, like the wizard config itself, so it can't go stale.
  const organizationId = activeOrgId();
  const res = await api.post<{ id: string }>('/api/data-lakes', {
    name: config.name,
    // The slug we ask for. The server disambiguates it against lakes in scope, so the created
    // lake's real slug can differ - everything downstream keys off the id.
    slug: slugifyDataLakeName(config.name),
    description: config.description || undefined,
    fileTagPrefix: tagPrefix,
    requiredUserTag: config.requiredUserTag || undefined,
    requiredEntitlement: config.requiredEntitlement || undefined,
    ...(organizationId ? { organizationId } : {}),
  } satisfies CreateDataLakeRequestInputType);
  return res.data.id;
}

/**
 * Whether a create-mode retry should reuse the lake a previous attempt in this session
 * archived, rather than creating a new one. True only when the retry lands in the same scope
 * with the same tag prefix - that pair is exactly what the archived lake's claim occupies
 * (findCollidingPrefixLakes), so changing either means nothing claims what this retry asks for
 * and createWizardLake succeeds on its own with no need to restore anything.
 */
export function canReuseRecoverableLake(
  recoverableLake: RecoverableLake | null,
  tagPrefix: string,
  organizationId: string | undefined
): recoverableLake is RecoverableLake {
  return (
    recoverableLake !== null &&
    recoverableLake.tagPrefix === tagPrefix &&
    recoverableLake.organizationId === organizationId
  );
}

/**
 * Restore a lake a previous failed attempt archived, so this retry can upload into it instead
 * of creating a second one that would collide on the still-held tag prefix. Only called
 * when canReuseRecoverableLake is true, i.e. the archive was this same lake's own rollback.
 */
export async function restoreRecoverableLake(dataLakeId: string): Promise<string> {
  await api.post(`/api/data-lakes/${dataLakeId}/lifecycle`, { action: 'unarchive' });
  return dataLakeId;
}

/**
 * Re-apply the wizard's current Configure values to a lake being reused. The restored lake still
 * carries the settings the FIRST attempt created it with, and the failure leaves Configure fully
 * editable behind it - so without this, edits made before the retry are silently dropped. That
 * matters most for requiredUserTag / requiredEntitlement: a user who adds an access gate before
 * retrying would otherwise land their files in an ungated lake with nothing reported.
 *
 * '' is the server's explicit clear sentinel for both gate fields (see UpdateDataLakeRequestInput),
 * so a gate REMOVED between attempts is removed here too. `slug` is not updatable on this route;
 * a reused lake keeps its original slug, which is inert because everything downstream keys off the id.
 */
export async function syncRestoredLakeConfig(dataLakeId: string, config: DataLakeFormValues): Promise<void> {
  await api.put(`/api/data-lakes/${dataLakeId}`, {
    name: config.name,
    description: config.description,
    requiredUserTag: config.requiredUserTag,
    requiredEntitlement: config.requiredEntitlement,
  } satisfies UpdateDataLakeRequestInputType);
}

/**
 * Soft-delete the 0-chunk FabFiles a failed upload left behind (created at presign, no S3 object).
 * MUST run before the lake is archived on the create-mode rollback paths: archiveByDataLakeTag
 * matches the lake's members by meta-tag with no status or chunk-count filter and skips only rows
 * already soft-deleted, and unarchiveByDataLakeTag reverses exactly that set under the lake's
 * filesArchivedAt stamp. An orphan still live at archive time is therefore brought BACK by the
 * retry's restore, and shows up alongside the retried file as a member with no bytes and no chunks
 * - which the retry's own dedup pass can't catch either, since nothing is live yet when it runs.
 *
 * Only the ids go: `failedFiles` is an $inc and `failedFileNames` a $set on the same batch the
 * caller already stamped, so re-sending them here would double-count. Best-effort, like the other
 * rollback calls - the server-side reconciler is the backstop, and this must not mask the real error.
 */
export async function deleteFailedUploadOrphans(batchId: string | undefined, failedFileIds: string[]): Promise<void> {
  if (!batchId || failedFileIds.length === 0) return;
  await api.post('/api/data-lakes/batches/upload-complete', { batchId, failedFileIds }).catch(() => {});
}

/**
 * The lake a create-mode commit targets: the one a prior failed attempt in this session left
 * archived when its claim still matches, otherwise a brand-new one.
 *
 * Shared by BOTH create-mode commit paths - the batch upload and the fileless Drive-only create
 * (useCreateLakeFromDrive) - because both archive the lake they just made when the commit fails,
 * and an archived lake keeps its prefix claim either way. Takes the store setter rather than the
 * whole callback bag so the Drive path, which has no batch and no upload progress, can call it.
 */
export async function resolveCreateModeLake(
  config: DataLakeFormValues,
  tagPrefix: string,
  recoverableLake: RecoverableLake | null,
  setRecoverableLake: (lake: RecoverableLake | null) => void
): Promise<string> {
  // Read at call time, like createWizardLake does, so a switch made behind the wizard modal counts.
  const organizationId = activeOrgId();
  if (!canReuseRecoverableLake(recoverableLake, tagPrefix, organizationId)) {
    return createWizardLake(config, tagPrefix);
  }

  if (!recoverableLake.restored) {
    try {
      await restoreRecoverableLake(recoverableLake.id);
    } catch (restoreErr: unknown) {
      // Only a 404 means the remembered lake is truly gone (e.g. purged after the user
      // permanently deleted it from the Archived section) - its prefix claim is gone with
      // it, so a fresh create is exactly as valid as the reuse would have been. Any other
      // failure (a transient error, a permission change, a status the lake moved to that
      // unarchive won't cross) leaves the lake, and its prefix claim, in place -
      // findCollidingPrefixLakes has no status filter, so falling back to create here would
      // just reproduce the original collision this reuse logic exists to prevent. Surface
      // the real restore failure instead and keep the lake remembered for the next retry.
      if (axios.isAxiosError(restoreErr) && restoreErr.response?.status === 404) {
        setRecoverableLake(null);
        return createWizardLake(config, tagPrefix);
      }
      throw restoreErr;
    }
    // Recorded BEFORE the config sync below, which can fail on its own: unarchive refuses a lake
    // already back in 'active' status with a 400, and a 400 is precisely what the branch above
    // rethrows - so without this flag one failed sync would wedge every later retry.
    setRecoverableLake({ ...recoverableLake, restored: true });
  }

  await syncRestoredLakeConfig(recoverableLake.id, config);
  return recoverableLake.id;
}

/** Bind a Drive folder picked during create to the lake that now exists (POST drive-sync). */
export async function connectPendingDriveFolder(dataLakeId: string, folder: PendingDriveFolder): Promise<void> {
  await api.post('/api/data-lakes/drive-sync', { dataLakeId, ...folder });
}

/**
 * Upload one file to the URL the server returned - a same-origin proxy (self-host) or an
 * S3 presigned URL (hosted). The auth routing (authenticated api client vs raw axios) lives
 * in uploadFileToUrl so this and the single-file path stay in sync.
 */
async function uploadFileToS3(url: string, file: File): Promise<void> {
  await uploadFileToUrl(url, file, file.type);
}

/**
 * Run `worker` over every item in `items` with at most `limit` in flight at once.
 * Never rejects: a worker failure is the caller's job to account for (both call
 * sites track their own per-item success/failure inside the worker closure), so a
 * throw here is swallowed rather than aborting the other in-flight items.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const total = queue.length;
  if (total === 0) return;
  // Guard a non-positive limit so the pump can always make progress instead of hanging forever.
  const cap = Math.max(1, limit);

  return new Promise<void>(resolve => {
    let active = 0;
    let done = 0;

    function processNext() {
      while (active < cap && queue.length > 0) {
        const item = queue.shift()!;
        active++;

        const settle = () => {
          active--;
          done++;
          if (done === total) {
            resolve();
          } else {
            processNext();
          }
        };

        try {
          worker(item)
            .catch(() => {
              // Swallow: the pump's contract is "never rejects" - the worker already
              // recorded its own failure (progress/counters) before this catch runs.
            })
            .finally(settle);
        } catch {
          // Swallow a synchronous throw from `worker` itself too, so a non-async
          // worker can't leak this slot or escape the pump's "never rejects" contract.
          settle();
        }
      }
    }

    processNext();
  });
}

// -- Batch Upload orchestration ------------------------------------------------

/**
 * Callbacks the caller (useBatchUpload) supplies so this pure-ish orchestration
 * function can drive the wizard's store/step and react to completion - the seam
 * keeps this module's store coupling read-only (getState only), never importing
 * React or the store's write actions directly.
 */
export interface BatchUploadCallbacks {
  /** Store writers, injected so the pipeline never subscribes to react state. */
  updateUploadProgress: (progress: Partial<UploadProgress>) => void;
  /** Store writers, injected so the pipeline never subscribes to react state. */
  setStep: (step: WizardStep) => void;
  /** Store writer, injected so the pipeline never subscribes to react state. See RecoverableLake. */
  setRecoverableLake: (lake: RecoverableLake | null) => void;
  /** Invalidate the lake list + gears status after upload-complete (the hook passes a closure over queryClient). */
  onUploadComplete: () => void;
}

/**
 * Orchestrates the full batch upload flow.
 * 1. Creates data lake
 * 2. Creates batch record
 * 3. Requests presigned URLs in chunks of 100
 * 4. Uploads files to S3 with concurrency limit
 * 5. Updates progress in store
 */
export async function runBatchUpload(cb: BatchUploadCallbacks): Promise<{
  dataLakeId: string;
  batchId: string | undefined;
  uploadedCount: number;
  failedCount: number;
}> {
  // Read from store at mutation time to avoid stale closure
  // (same pattern as useComputeHashes)
  const { config, allFiles, targetLake, optionalSteps, pendingDriveFolder, recoverableLake } =
    useDataLakeWizardStore.getState();
  let included = allFiles.filter(f => !f.excluded);
  if (included.length === 0) throw new Error('No files to upload');

  // Gate unsupported/binary file types (e.g. .exe) BEFORE creating any lake
  // or batch, so a stray unsupported file can't fail the whole upload
  // server-side or leave partial state. The server re-validates as the hard
  // boundary.
  const unsupported = included.filter(f => !isSupportedFabFileMimeType(f.type));
  if (unsupported.length > 0) {
    included = included.filter(f => isSupportedFabFileMimeType(f.type));
    const sampleExts = Array.from(
      new Set(
        unsupported.map(f => {
          const dot = f.file.name.lastIndexOf('.');
          return dot > -1 ? f.file.name.slice(dot).toLowerCase() : f.file.name;
        })
      )
    ).slice(0, 5);
    toast.warning(
      `Skipped ${unsupported.length} unsupported file${unsupported.length === 1 ? '' : 's'} (${sampleExts.join(
        ', '
      )}). Only documents, images, code, and text files can be ingested.`
    );
    if (included.length === 0) {
      throw new Error('No supported files to upload. Only documents, images, code, and text files can be ingested.');
    }
  }

  // Apply conflict resolution for duplicates
  if (config.conflictResolution === 'skip') {
    included = included.filter(f => !f.isDuplicate);
    if (included.length === 0) throw new Error('All files are duplicates (skipped)');
  }
  // 'update' and 'duplicate' both upload: 'update' will overwrite, 'duplicate' creates new

  // Exactly the value every client-side rule judged (see submittedTagPrefix), so what was
  // gated is what gets sent.
  const tagPrefix = submittedTagPrefix(config.tagPrefix);

  // Step 1: Create the data lake; skipped in append mode (upload into the existing lake), and
  // skipped when a same-session prior attempt archived a lake holding this exact prefix claim -
  // restore and reuse it instead of creating a second one the claim would refuse.
  const dataLakeId = targetLake
    ? targetLake.id
    : await resolveCreateModeLake(config, tagPrefix, recoverableLake, cb.setRecoverableLake);
  let uploadedCount = 0;
  // Hoisted above the try so the outcome branch + the catch can reconcile the batch
  // and clean up the records setup created. `failedFileIds` are the FabFiles presign
  // created (createFabFile) whose bytes never uploaded - the 0-chunk orphans.
  // `reconciled` tells the catch the outcome branch already handled cleanup, so the
  // catch only rolls back a setup-phase failure (e.g. creating the batch threw).
  let batchId: string | undefined;
  // The first presign refusal, kept so a batch where NOTHING uploaded can report the
  // server's actual reason instead of the generic transport message below.
  let firstPresignError: unknown;
  let failedCount = 0;
  const failedNames: string[] = [];
  const failedFileIds: string[] = [];
  let reconciled = false;

  // The lake and the per-file FabFile records are created before the bytes upload, so
  // a failure below leaves orphan state (empty lake, 0-chunk FabFiles, a batch stuck
  // mid-flight). The outcome branch after the upload loop rolls that back.
  try {
    const totalSizeBytes = included.reduce((sum, f) => sum + f.size, 0);

    // Per-file tags: each file's source folder. AI-suggested categories are no
    // longer applied at upload time - they run as a background job afterward and get
    // applied later, from the Data Lakes list, once reviewed. The lake meta-tag is
    // added server-side.
    const appliedTags = foldersTagsForBatch(included, tagPrefix);

    // Step 2: Create batch record
    const batchRes = await api.post<{ id: string }>('/api/data-lakes/batches', {
      dataLakeId,
      totalFiles: included.length,
      totalSizeBytes,
      appliedTags,
      // Never true in append mode - the source step doesn't offer the toggle there.
      wantsTaxonomy: optionalSteps.taxonomy,
    });

    batchId = batchRes.data.id;

    // Switch to upload step and set initial progress
    cb.setStep('upload');
    cb.updateUploadProgress({
      ...zeroProgressCounts(),
      totalFiles: included.length,
      status: 'uploading',
      currentBatchId: batchId,
      // Clear any error from a prior attempt so a retry starts clean.
      errorMessage: undefined,
      errorKind: undefined,
    });

    // Step 3: Request presigned URLs in chunks and upload
    for (let i = 0; i < included.length; i += BATCH_CHUNK_SIZE) {
      const chunk = included.slice(i, i + BATCH_CHUNK_SIZE);

      // Presign per chunk. If it fails, count this chunk's files as failed and move
      // on rather than throwing: a throw would abandon already-uploaded earlier chunks
      // (their files land but the batch is torn down as a total failure). No FabFiles
      // were created for a chunk whose presign failed, so there is nothing to clean up.
      let urlMap: { fileId: string; fileKey: string; url: string; fileName: string }[];
      try {
        const urlsRes = await api.post<{
          files: { fileId: string; fileKey: string; url: string; fileName: string }[];
        }>('/api/files/generate-presigned-urls-batch', {
          files: chunk.map(f => ({
            fileName: f.file.name,
            mimeType: f.type || 'application/octet-stream',
            fileSize: f.size,
            relativePath: f.relativePath,
            ...(f.contentHash && { contentHash: f.contentHash }),
            // Just the source-folder tag - AI-suggested categories are applied
            // later, post-upload, once the background job's suggestions are reviewed.
            tags: folderTagForFile(f.relativePath, tagPrefix),
          })),
          // The lake id, never a slug derived from the name: on a name collision the server
          // creates the lake under a disambiguated slug, and the name-derived one still
          // resolves - to the lake that was already there, possibly another user's. The
          // route accepts either form.
          dataLakeSlug: dataLakeId,
          // Correlate every uploaded file to its batch so the pipeline
          // (objectCreated -> chunk -> vectorize) updates batch progress and the
          // batch can complete. Also populates the batch manifest server-side.
          batchId,
        });
        urlMap = urlsRes.data.files;
      } catch (err) {
        if (firstPresignError === undefined) firstPresignError = err;
        for (const f of chunk) {
          failedCount++;
          failedNames.push(f.file.name);
        }
        cb.updateUploadProgress({ failedFiles: failedCount, failedFileNames: [...failedNames] });
        continue;
      }

      // Build a lookup by fileName. If filenames collide across folders, the last
      // one wins - a known limitation until the server echoes relativePath in responses.
      const chunkByName = new Map(chunk.map(f => [f.file.name, f]));

      await runWithConcurrency(urlMap, UPLOAD_CONCURRENCY, async urlInfo => {
        // Match by fileName (best available from server response).
        // If no match found, skip this entry rather than uploading the wrong file.
        const wizFile = chunkByName.get(urlInfo.fileName);
        if (!wizFile) {
          failedCount++;
          failedNames.push(urlInfo.fileName);
          failedFileIds.push(urlInfo.fileId);
          cb.updateUploadProgress({ failedFiles: failedCount, failedFileNames: [...failedNames] });
          return;
        }
        try {
          await uploadFileToS3(urlInfo.url, wizFile.file);
          uploadedCount++;
          cb.updateUploadProgress({ uploadedFiles: uploadedCount });
        } catch {
          failedCount++;
          failedNames.push(wizFile.file.name);
          failedFileIds.push(urlInfo.fileId);
          cb.updateUploadProgress({ failedFiles: failedCount, failedFileNames: [...failedNames] });
        }
      });
    }

    // Every chunk has been attempted. Decide the outcome explicitly here rather than
    // leaning on a thrown error to signal "total failure" (that conflated a mid-loop
    // throw, which can happen after earlier chunks already uploaded, with nothing
    // landing - and stranded those uploaded files).
    if (uploadedCount === 0) {
      // Nothing landed, so no pipeline is running for this batch - it's safe to force a
      // terminal state and roll back what setup created.
      reconciled = true;
      if (targetLake) {
        // Append: keep the user's existing lake, but delete the orphan FabFiles, account
        // the failures, and finalize (upload-complete does all three server-side).
        await api
          .post('/api/data-lakes/batches/upload-complete', {
            batchId,
            failedFiles: failedCount,
            failedFileNames: failedNames,
            failedFileIds,
          })
          .catch(() => {});
      } else {
        // Create: archive the empty new lake (cascade cancels the batch and soft-archives its
        // FabFiles - a reversible marker, NOT a teardown, which is why the orphans have to be
        // deleted separately below); stamp 'failed' first so the terminal state is accurate
        // rather than the archive's 'cancelled'.
        await api
          .put(`/api/data-lakes/batches/${batchId}`, {
            status: 'failed',
            failedFiles: failedCount,
            failedFileNames: failedNames,
          })
          .catch(() => {});
        // After the 'failed' stamp above, which is terminal: upload-complete's own status flip and
        // finalize are both guarded to non-terminal batches, so all it can still do here is the
        // orphan cleanup this path needs.
        await deleteFailedUploadOrphans(batchId, failedFileIds);
        const archived = await api
          .delete(`/api/data-lakes/${dataLakeId}`)
          .then(() => true)
          .catch(() => false);
        // Remember it for a same-session retry - but only once we know the archive
        // actually took, so a retry never tries to restore a lake still live in some other state.
        cb.setRecoverableLake(archived ? { id: dataLakeId, tagPrefix, organizationId: activeOrgId() } : null);
      }
      // A presign refusal already says WHY (e.g. the request did not name the batch's lake),
      // and classifyUploadError surfaces a 4xx's server message - so rethrow it rather than
      // blaming the network. Only when it carries a status: a timeout or abort has no response
      // and would fall through to its raw axios text ("timeout of 30000ms exceeded"), where the
      // generic transport message is both friendlier and true.
      const refusalStatus = axios.isAxiosError(firstPresignError) ? firstPresignError.response?.status : undefined;
      throw refusalStatus ? firstPresignError : new Error(UPLOAD_ALL_FAILED_MESSAGE);
    }

    // Partial or full success: the uploaded files proceed through the pipeline.
    // (An all-failed batch never reaches here - it throws above, since uploadedCount
    // is 0 iff failedCount === included.length.) upload-complete removes the failed
    // files' 0-chunk orphan FabFiles, accounts the browser failures so the completion
    // math can be satisfied (a partial batch used to hang at 'processing'), and
    // finalizes - all server-side, in the right order.
    reconciled = true;
    // Files landed in this lake, so it's no longer a candidate to restore-and-reuse on some
    // later, unrelated failure. Keyed on the id rather than just create mode: a retry that CHANGED
    // the tag prefix succeeds into a DIFFERENT, new lake while the remembered one stays archived,
    // still holding the original prefix and still invisible outside the Archived list. Clearing it
    // there would drop the only handle on it and leave the original prefix stuck exactly as #3231
    // describes - so it stays remembered, and a later retry that goes back to that prefix can
    // still reuse it.
    if (recoverableLake?.id === dataLakeId) cb.setRecoverableLake(null);
    await api
      .post('/api/data-lakes/batches/upload-complete', {
        batchId,
        failedFiles: failedCount,
        failedFileNames: failedNames,
        failedFileIds,
      })
      .catch(() => {});

    // A Drive folder picked during create is connected only HERE - after the lake exists and its
    // files have landed. Connecting any earlier would strand a connection row behind the rollback
    // the total-failure branch above performs on the new lake. Never in append mode: there
    // DriveConnectAction already connected on the spot.
    if (!targetLake && pendingDriveFolder) {
      try {
        await connectPendingDriveFolder(dataLakeId, pendingDriveFolder);
      } catch (e) {
        // The files are in, so the batch is a success - don't fail it over the Drive half.
        // Name the actual refusal (not an org manager, folder claimed elsewhere, Drive not
        // linked) AND where to retry, since this mutation offers no retry of its own.
        // Reason last: it is a server sentence of its own, with no punctuation we can rely on
        // to splice mid-message.
        toast.error(
          `Files uploaded, but the Google Drive folder was not connected - connect it from the data lake's header to retry. ${
            // Create-mode only (guarded above), so the classifier gets isAppend: false.
            classifyUploadError(e, { config: { name: config.name, tagPrefix: config.tagPrefix }, isAppend: false })
              .message
          }`,
          { duration: 10000 }
        );
      }
    }

    cb.updateUploadProgress({ status: 'complete' });

    cb.onUploadComplete();

    return { dataLakeId, batchId, uploadedCount, failedCount };
  } catch (err) {
    // Only a setup-phase failure reaches here un-reconciled (e.g. creating the batch
    // threw): the outcome branches above handle their own cleanup before throwing.
    // Nothing uploaded on this path, so roll back what setup created (best-effort - a
    // cleanup failure must not mask the real error; the reconciler is the backstop).
    if (!reconciled) {
      if (batchId) {
        await api.put(`/api/data-lakes/batches/${batchId}`, { status: 'failed' }).catch(() => {});
      }
      // Ungated by mode: an orphan left live is archived-then-restored with the lake in create
      // mode (see deleteFailedUploadOrphans) and simply inflates the user's own lake in append mode.
      await deleteFailedUploadOrphans(batchId, failedFileIds);
      // Never touch the user's existing lake in append mode.
      if (!targetLake) {
        const archived = await api
          .delete(`/api/data-lakes/${dataLakeId}`)
          .then(() => true)
          .catch(() => false);
        cb.setRecoverableLake(archived ? { id: dataLakeId, tagPrefix, organizationId: activeOrgId() } : null);
      }
    }
    throw err;
  }
}
