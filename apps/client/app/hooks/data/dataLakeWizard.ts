import { useEffect, useRef } from 'react';
import type { IMessageDataToClient, IFabFileDocument, ManageableDataLakeConfig } from '@bike4mind/common';
import { isSupportedFabFileMimeType, folderTagForFile } from '@bike4mind/common';
import type { CreateDataLakeRequestInputType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  useDataLakeWizardStore,
  type UploadProgress,
  type UploadErrorKind,
} from '@client/app/stores/useDataLakeWizardStore';
import { activeOrgId } from '@client/app/hooks/data/dataLakes';
import { slugifyDataLakeName, MIN_DATA_LAKE_SLUG_LENGTH } from '@client/app/hooks/data/dataLakeSlug';
import { computeFileHash } from '@client/app/utils/folderTreeParser';
import { invalidateGearsStatusWhileLocked } from '@client/app/hooks/useGearsStatus';
import axios from 'axios';
import { uploadFileToUrl } from '@client/app/utils/uploadFileToUrl';

/** Union of every file's folder tag, for the batch record's appliedTags summary. AI-suggested
 * category tags are no longer part of this - they're applied later, post-upload. */
function foldersTagsForBatch(
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

// ── Hashing & Deduplication ──────────────────────────────────────────────────

const HASH_CONCURRENCY = 10;
const DEDUP_BATCH_SIZE = 500;

/**
 * Hook: Compute SHA-256 hashes for all included files.
 * Runs with concurrency limit to avoid blocking the main thread too hard.
 */
export function useComputeHashes() {
  const setFileHash = useDataLakeWizardStore(s => s.setFileHash);
  const updateHashingProgress = useDataLakeWizardStore(s => s.updateHashingProgress);

  return useMutation({
    mutationFn: async () => {
      // Read allFiles from store at mutation time to avoid stale closure
      const allFiles = useDataLakeWizardStore.getState().allFiles;
      const included = allFiles.filter(f => !f.excluded && !f.contentHash);
      if (included.length === 0) return { hashed: 0 };

      updateHashingProgress({ total: included.length, completed: 0, status: 'hashing' });

      let completed = 0;
      const queue = [...included];

      // Process with concurrency limit
      await new Promise<void>(resolve => {
        let active = 0;
        let done = 0;
        const total = queue.length;

        function processNext() {
          while (active < HASH_CONCURRENCY && queue.length > 0) {
            const file = queue.shift()!;
            active++;

            computeFileHash(file.file)
              .then(hash => {
                setFileHash(file.relativePath, hash);
                completed++;
                updateHashingProgress({ completed });
              })
              .catch(() => {
                // If hashing fails, skip; file will upload without dedup
                completed++;
                updateHashingProgress({ completed });
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

      updateHashingProgress({ status: 'done' });
      return { hashed: completed };
    },
    onSuccess: result => {
      toast.success(`Hashed ${result.hashed} files for deduplication`);
    },
    onError: (error: Error) => {
      updateHashingProgress({ status: 'done' });
      toast.error(error.message || 'Failed to compute file hashes');
    },
  });
}

/**
 * Hook: Check hashed files against existing uploads for duplicates.
 */
export function useCheckDuplicates() {
  const markDuplicates = useDataLakeWizardStore(s => s.markDuplicates);

  return useMutation({
    mutationFn: async () => {
      // Read allFiles from store at mutation time to avoid stale closure
      const allFiles = useDataLakeWizardStore.getState().allFiles;
      const withHash = allFiles.filter(f => !f.excluded && f.contentHash);
      if (withHash.length === 0) return { duplicateCount: 0 };

      const allDuplicates: { hash: string; fileId: string }[] = [];

      // Check in batches of 500 (API limit)
      for (let i = 0; i < withHash.length; i += DEDUP_BATCH_SIZE) {
        const batch = withHash.slice(i, i + DEDUP_BATCH_SIZE);
        const hashes = batch.map(f => f.contentHash!);

        const res = await api.post<{
          duplicates: { hash: string; fileId: string; fileName: string }[];
        }>('/api/files/check-duplicates', { hashes });

        allDuplicates.push(...res.data.duplicates);
      }

      markDuplicates(allDuplicates);
      return { duplicateCount: allDuplicates.length };
    },
    onSuccess: result => {
      if (result.duplicateCount > 0) {
        toast.warning(`Found ${result.duplicateCount} duplicate files`);
      } else {
        toast.success('No duplicate files found');
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to check for duplicates');
    },
  });
}

// ── Batch Upload ─────────────────────────────────────────────────────────────

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
 * Keep the rule thresholds in sync with CreateDataLakeRequestInput (common/schemas/dataLake).
 */
function classifyUploadError(error: unknown): { kind: UploadErrorKind; message: string } {
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
    const { config, targetLake } = useDataLakeWizardStore.getState();
    // Only create mode submits a name and prefix; append mode locks both, so neither can be
    // what the server rejected there - fall through to the neutral message instead.
    if (!targetLake) {
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
async function uploadFileToS3(url: string, file: File): Promise<void> {
  await uploadFileToUrl(url, file, file.type);
}

/**
 * Hook: Orchestrates the full batch upload flow.
 * 1. Creates data lake
 * 2. Creates batch record
 * 3. Requests presigned URLs in chunks of 100
 * 4. Uploads files to S3 with concurrency limit
 * 5. Updates progress in store
 */
export function useBatchUpload() {
  const updateUploadProgress = useDataLakeWizardStore(s => s.updateUploadProgress);
  const setStep = useDataLakeWizardStore(s => s.setStep);
  const queryClient = useQueryClient();
  // Lets onError's toast retry action call back into the mutation it belongs to,
  // without a circular reference to the useMutation() result being built below.
  const retryRef = useRef<() => void>(() => {});

  const mutation = useMutation({
    mutationFn: async () => {
      // Fail fast instead of letting the request go out and eventually reject -
      // matches the check in DataLakeWizardModal's handleStartUpload, which
      // catches the initial click; this one catches a retry from the error
      // toast, which calls mutate() directly.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error(OFFLINE_MESSAGE);
      }

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
          throw new Error(
            'No supported files to upload. Only documents, images, code, and text files can be ingested.'
          );
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
        setStep('upload');
        updateUploadProgress({
          totalFiles: included.length,
          uploadedFiles: 0,
          chunkedFiles: 0,
          vectorizedFiles: 0,
          failedFiles: 0,
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
            updateUploadProgress({ failedFiles: failedCount, failedFileNames: [...failedNames] });
            continue;
          }

          // Build a lookup by fileName. If filenames collide across folders, the last
          // one wins - a known limitation until the server echoes relativePath in responses.
          const chunkByName = new Map(chunk.map(f => [f.file.name, f]));

          // Simple semaphore for concurrency limiting
          let active = 0;
          const queue = [...urlMap];

          await new Promise<void>((resolve, reject) => {
            let completed = 0;
            const total = urlMap.length;

            if (total === 0) {
              resolve();
              return;
            }

            function processNext() {
              while (active < UPLOAD_CONCURRENCY && queue.length > 0) {
                const urlInfo = queue.shift();
                if (!urlInfo) break;
                // Match by fileName (best available from server response).
                // If no match found, skip this entry rather than uploading the wrong file.
                const wizFile = chunkByName.get(urlInfo.fileName);
                if (!wizFile) {
                  failedCount++;
                  failedNames.push(urlInfo.fileName);
                  failedFileIds.push(urlInfo.fileId);
                  updateUploadProgress({ failedFiles: failedCount, failedFileNames: [...failedNames] });
                  completed++;
                  if (completed === total) {
                    resolve();
                  }
                  continue;
                }
                active++;

                uploadFileToS3(urlInfo.url, wizFile.file)
                  .then(() => {
                    uploadedCount++;
                    updateUploadProgress({ uploadedFiles: uploadedCount });
                  })
                  .catch(() => {
                    failedCount++;
                    failedNames.push(wizFile.file.name);
                    failedFileIds.push(urlInfo.fileId);
                    updateUploadProgress({ failedFiles: failedCount, failedFileNames: [...failedNames] });
                  })
                  .finally(() => {
                    active--;
                    completed++;
                    if (completed === total) {
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

        updateUploadProgress({ status: 'complete' });

        queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
        // First lake unlocks the 'datalakes' nav slot; first file unlocks 'files'.
        // Reveal them without waiting out the gears/status staleTime (#833).
        invalidateGearsStatusWhileLocked(queryClient, ['datalakes', 'files']);

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
    },
    onSuccess: result => {
      if (result.failedCount === 0) {
        toast.success(`All ${result.uploadedCount} files uploaded successfully!`);
      } else {
        toast.warning(`${result.uploadedCount} uploaded, ${result.failedCount} failed`);
      }
    },
    onError: (error: unknown) => {
      // Classify into a distinct kind + human message. Critically, a validation (422)
      // failure is translated from the config here - the server's raw zod/validator
      // text must never reach the UI.
      const { kind, message } = classifyUploadError(error);
      updateUploadProgress({ status: 'error', errorKind: kind, errorMessage: message });
      // This can fire before setStep('upload') runs (e.g. the very first request
      // fails while offline), leaving the wizard on the Configure step with no
      // other feedback - so this toast's retry action is the only signal the user
      // gets.
      // Stable id: a retry that fails again (e.g. still offline) replaces this
      // toast instead of stacking a new one on top of it - same id as the
      // pre-flight check in DataLakeWizardModal's handleStartUpload, since both
      // represent the one current upload attempt's error state.
      toast.error(message, {
        id: 'data-lake-batch-upload-error',
        duration: 8000,
        action: { label: 'Retry', onClick: () => retryRef.current() },
      });
    },
  });

  useEffect(() => {
    retryRef.current = () => mutation.mutate();
  });
  return mutation;
}

// ── WebSocket Progress Listener ─────────────────────────────────────────────

/**
 * Hook: Subscribe to real-time batch progress updates via WebSocket.
 * Updates chunkedFiles and vectorizedFiles counters as the server processes files.
 * Should be mounted in any component that displays upload progress.
 */
export function useBatchProgressListener() {
  const { subscribeToAction } = useWebsocket();
  // Use targeted selector - subscribing to the full uploadProgress object would
  // cause re-render then unsubscribe/resubscribe on every progress tick
  const batchId = useDataLakeWizardStore(s => s.uploadProgress.currentBatchId);
  const updateUploadProgress = useDataLakeWizardStore(s => s.updateUploadProgress);

  useEffect(() => {
    if (!batchId) return;

    const unsubscribe = subscribeToAction('data_lake_batch_progress', async (message: IMessageDataToClient) => {
      if (message.action !== 'data_lake_batch_progress') return;
      if (message.batchId !== batchId) return;

      const updates: Partial<UploadProgress> = {};

      if (message.chunkedFiles !== undefined) {
        updates.chunkedFiles = message.chunkedFiles;
      }
      if (message.vectorizedFiles !== undefined) {
        updates.vectorizedFiles = message.vectorizedFiles;
      }
      if (message.failedFiles !== undefined) {
        updates.failedFiles = message.failedFiles;
      }
      if (message.status === 'completed' || message.status === 'completed_with_errors') {
        updates.status = 'complete';
      }
      if (message.taxonomyStatus !== undefined) {
        updates.taxonomyStatus = message.taxonomyStatus;
      }

      if (Object.keys(updates).length > 0) {
        updateUploadProgress(updates);
      }
    });

    return unsubscribe;
  }, [batchId, subscribeToAction, updateUploadProgress]);
}

// ── Data Lake File Viewer ───────────────────────────────────────────────────

/**
 * Hook: Fetch files belonging to a specific data lake by ID.
 */
export function useDataLakeFiles(dataLakeId: string | null, params?: { limit?: number }) {
  return useQuery({
    queryKey: ['dataLakeFiles', dataLakeId, params],
    queryFn: async () => {
      const response = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>(
        `/api/data-lakes/${dataLakeId}/articles`,
        { params: { limit: params?.limit ?? 100 } }
      );
      return response.data;
    },
    enabled: !!dataLakeId,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Hook: List all data lakes accessible to the current user.
 */
export function useDataLakes(enabled = true) {
  return useQuery({
    queryKey: ['data-lakes'],
    // Data lakes are an admin-gated feature (EnableDataLakes, default off); the
    // endpoint 403s when disabled. Skip the call until the consumer actually
    // needs it (e.g. the modal is open) and don't retry the gate rejection, so
    // a closed app-wide modal doesn't spam a 403 on every page.
    enabled,
    retry: false,
    queryFn: async () => {
      // The server's own shape, not a hand-maintained twin: `canManage` and the editor-only
      // `systemPrompt` are attached per lake by listDataLakes, and the latter only when the
      // caller may manage that lake. The former inline type also declared `createdAt` and
      // `fileCount`, neither of which this projection returns.
      const response = await api.get<{ data: ManageableDataLakeConfig[] }>('/api/data-lakes');
      return response.data.data;
    },
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 2,
  });
}

/**
 * Hook: Re-run chunking + vectorization for a single fabFile in a data lake.
 * Useful for files that landed with 0 chunks (failed/partial extraction).
 */
export function useReprocessFabFile(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fabFileId: string) => {
      const res = await api.post<{ messageId: string }>('/api/files/reprocess', { fabFileId });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Re-processing started — chunking and vectorization will re-run.');
      if (dataLakeId) queryClient.invalidateQueries({ queryKey: ['dataLakeFiles', dataLakeId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to re-process file');
    },
  });
}

/**
 * Hook: Remove a single file from a data lake. Drops the lake's membership tags from the file
 * and leaves the file itself alone - no soft-delete, no chunk teardown. Owner/admin only; the
 * server verifies the file actually belongs to the lake.
 */
export function useRemoveFileFromDataLake(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fabFileId: string) => {
      const res = await api.delete<{ success: true; fileCount: number; totalSizeBytes: number }>(
        `/api/data-lakes/${dataLakeId}/files/${fabFileId}`
      );
      return res.data;
    },
    onSuccess: () => {
      toast.success('File removed from data lake.');
      if (dataLakeId) queryClient.invalidateQueries({ queryKey: ['dataLakeFiles', dataLakeId] });
      // Refresh the lake list to pick up the recomputed stats. fileCount counts meta-tagged
      // files only, so removing a file that was in the lake by prefix alone drops a row from
      // the list without moving the count.
      queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
      // Removal also drops the file's tags under the lake's prefix, so every tag-derived view
      // is stale (incl. the manager's count-chip fallback). Invalidate on the bare key
      // prefixes: these are keyed by an opti/datalakes source discriminator, and a
      // fully-specified key would refresh only one surface.
      queryClient.invalidateQueries({ queryKey: ['dataLakeTagCounts'] });
      queryClient.invalidateQueries({ queryKey: ['dataLakeArticles'] });
      // Bare prefix: the tag list carries a fileCount derived from the files that hold each tag,
      // so dropping tags here staled the list too, not only the counts endpoint.
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to remove file from data lake');
    },
  });
}
