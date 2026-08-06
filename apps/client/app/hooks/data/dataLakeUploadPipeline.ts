import { folderTagForFile, isSupportedFabFileMimeType } from '@bike4mind/common';
import type { CreateDataLakeRequestInputType } from '@bike4mind/common';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import type { UploadErrorKind, UploadProgress, WizardStep } from '@client/app/stores/useDataLakeWizardStore';
import { slugifyDataLakeName, MIN_DATA_LAKE_SLUG_LENGTH } from '@client/app/hooks/data/dataLakeSlug';
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

// -- Hashing & Deduplication --------------------------------------------------

export const HASH_CONCURRENCY = 10;

// -- Batch Upload --------------------------------------------------------------

export const UPLOAD_CONCURRENCY = 5;
export const BATCH_CHUNK_SIZE = 100; // Max files per presigned URL request

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
 * Keep the rule thresholds in sync with CreateDataLakeRequestInput (common/schemas/dataLake).
 * `snapshot` is the config/isAppend state at the moment the failing request was made,
 * captured by the caller (store reads don't belong in this pure module).
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
          message: 'The data lake name is too short. Use a name with at least 2 letters or numbers.',
        };
      }
      const prefix = config.tagPrefix.endsWith(':') ? config.tagPrefix : `${config.tagPrefix}:`;
      if (prefix.length < 2) {
        return {
          kind: 'validation',
          message: 'The tag prefix is too short. Use at least 2 characters ending in ":" (e.g. "legal:").',
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
 * Upload one file to the URL the server returned - a same-origin proxy (self-host) or an
 * S3 presigned URL (hosted). The auth routing (authenticated api client vs raw axios) lives
 * in uploadFileToUrl so this and the single-file path stay in sync.
 */
export async function uploadFileToS3(url: string, file: File): Promise<void> {
  await uploadFileToUrl(url, file, file.type);
}

/**
 * Run `worker` over every item in `queue` with at most `limit` in flight at once.
 * Never rejects: a worker failure is the caller's job to account for (both call
 * sites track their own per-item success/failure inside the worker closure), so a
 * throw here is swallowed rather than aborting the other in-flight items.
 */
export async function runWithConcurrency<T>(
  queue: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const items = [...queue];
  const total = items.length;
  if (total === 0) return;

  return new Promise<void>(resolve => {
    let active = 0;
    let done = 0;

    function processNext() {
      while (active < limit && items.length > 0) {
        const item = items.shift()!;
        active++;

        worker(item)
          .catch(() => {
            // Swallow: the pump's contract is "never rejects" - the worker already
            // recorded its own failure (progress/counters) before this catch runs.
          })
          .finally(() => {
            active--;
            done++;
            if (done === total) {
              resolve();
            } else {
              processNext();
            }
          });
      }
    }

    processNext();
  });
}

// -- Batch Upload orchestration ------------------------------------------------

/**
 * Callbacks the caller (useBatchUpload) supplies so this pure-ish orchestration
 * function can drive the wizard's store/step and react to completion without
 * importing React or the store's write actions directly.
 */
export interface BatchUploadCallbacks {
  updateUploadProgress: (progress: Partial<UploadProgress>) => void;
  setStep: (step: WizardStep) => void;
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
  const { config, allFiles, targetLake, optionalSteps } = useDataLakeWizardStore.getState();
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

  // Ensure tag prefix ends with ':'
  const tagPrefix = config.tagPrefix.endsWith(':') ? config.tagPrefix : config.tagPrefix + ':';

  // Step 1: Create the data lake; skipped in append mode (upload into the existing lake).
  let dataLakeId: string;
  if (targetLake) {
    dataLakeId = targetLake.id;
  } else {
    // Scope to the active account-switcher org (Personal -> undefined). activeOrgId reads
    // the store at mutation time, like the wizard config above, so it can't go stale.
    const organizationId = activeOrgId();
    const dataLakeRes = await api.post<{ id: string }>('/api/data-lakes', {
      name: config.name,
      // The slug we ask for. The server disambiguates it against lakes in scope, so the
      // created lake's real slug can differ - everything downstream keys off the id.
      slug: slugifyDataLakeName(config.name),
      description: config.description || undefined,
      fileTagPrefix: tagPrefix,
      requiredUserTag: config.requiredUserTag || undefined,
      requiredEntitlement: config.requiredEntitlement || undefined,
      ...(organizationId ? { organizationId } : {}),
    } satisfies CreateDataLakeRequestInputType);
    dataLakeId = dataLakeRes.data.id;
  }
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
      totalFiles: included.length,
      uploadedFiles: 0,
      chunkedFiles: 0,
      vectorizedFiles: 0,
      failedFiles: 0,
      processingFailedFiles: 0,
      failedFileNames: [],
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
        // Create: archive the empty new lake (cascade cancels the batch and tears down
        // its FabFiles); stamp 'failed' first so the terminal state is accurate rather
        // than the archive's 'cancelled'.
        await api
          .put(`/api/data-lakes/batches/${batchId}`, {
            status: 'failed',
            failedFiles: failedCount,
            failedFileNames: failedNames,
          })
          .catch(() => {});
        await api.delete(`/api/data-lakes/${dataLakeId}`).catch(() => {});
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
    await api
      .post('/api/data-lakes/batches/upload-complete', {
        batchId,
        failedFiles: failedCount,
        failedFileNames: failedNames,
        failedFileIds,
      })
      .catch(() => {});

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
      // Never touch the user's existing lake in append mode.
      if (!targetLake) {
        await api.delete(`/api/data-lakes/${dataLakeId}`).catch(() => {});
      }
    }
    throw err;
  }
}
