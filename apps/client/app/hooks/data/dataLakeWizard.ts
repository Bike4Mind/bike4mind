import { useEffect, useRef } from 'react';
import type {
  InferTaxonomyResponse,
  InferTaxonomyRequestInputType,
  IMessageDataToClient,
  IFabFileDocument,
} from '@bike4mind/common';
import { isSupportedFabFileMimeType } from '@bike4mind/common';
import type { CreateDataLakeRequestInputType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useDataLakeWizardStore, type UploadProgress } from '@client/app/stores/useDataLakeWizardStore';
import { activeOrgId } from '@client/app/hooks/data/dataLakes';
import type { WizardFile } from '@client/app/utils/folderTreeParser';
import { computeFileHash } from '@client/app/utils/folderTreeParser';
import axios from 'axios';

/**
 * Derive a single tag for a file from its immediate parent folder, so each file
 * is tagged by its source folder (e.g. a disease site) rather than getting every
 * taxonomy category. Returns [] for root-level files (they get only the lake
 * meta-tag). Uses underscores to match the AI taxonomy's folder-slug style.
 */
function folderTagForFile(relativePath: string, tagPrefix: string): { name: string; strength: number }[] {
  const segments = relativePath.split('/').filter(Boolean);
  const parent = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  if (!parent) return [];
  const slug = parent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return [];
  const prefix = tagPrefix.endsWith(':') ? tagPrefix : `${tagPrefix}:`;
  return [{ name: `${prefix}${slug}`, strength: 1.0 }];
}

/**
 * Stratified sampling: pick up to `maxPerFolder` files from each unique folder path,
 * capped at `maxTotal` files overall.
 */
function sampleFiles(files: WizardFile[], maxPerFolder = 5, maxTotal = 50): WizardFile[] {
  const byFolder = new Map<string, WizardFile[]>();

  for (const f of files) {
    const parts = f.relativePath.split('/');
    const folderPath = parts.slice(0, -1).join('/') || '/';
    const group = byFolder.get(folderPath) || [];
    group.push(f);
    byFolder.set(folderPath, group);
  }

  const sampled: WizardFile[] = [];
  for (const [, group] of byFolder) {
    const take = group.slice(0, maxPerFolder);
    sampled.push(...take);
    if (sampled.length >= maxTotal) break;
  }

  return sampled.slice(0, maxTotal);
}

/**
 * Read first N bytes of a File as text for content sampling.
 */
async function readContentSample(file: File, maxBytes = 500): Promise<string> {
  const blob = file.slice(0, maxBytes);
  try {
    return await blob.text();
  } catch {
    return '';
  }
}

/**
 * Hook: Infer taxonomy from folder structure using AI.
 */
export function useInferTaxonomy() {
  const folderTree = useDataLakeWizardStore(s => s.folderTree);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const setTaxonomy = useDataLakeWizardStore(s => s.setTaxonomy);
  const setTaxonomyAnalyzing = useDataLakeWizardStore(s => s.setTaxonomyAnalyzing);

  return useMutation({
    mutationFn: async (options?: { context?: string; existingPrefix?: string }) => {
      if (!folderTree) throw new Error('No folder tree loaded');

      const included = allFiles.filter(f => !f.excluded);
      if (included.length === 0) throw new Error('No files included');

      const sampled = sampleFiles(included);

      // Build folder entries with optional content samples
      const folderEntries: InferTaxonomyRequestInputType['folderTree'] = await Promise.all(
        sampled.map(async f => {
          // Only sample text-like files for content preview
          const isTextLike =
            /^(text\/|application\/json|application\/xml)/.test(f.type) ||
            /\.(txt|md|csv|json|html|xml|log|yaml|yml|toml|ini|cfg)$/i.test(f.file.name);

          const contentSample = isTextLike ? await readContentSample(f.file) : undefined;

          return {
            relativePath: f.relativePath,
            fileName: f.file.name,
            fileSize: f.size,
            mimeType: f.type || undefined,
            contentSample: contentSample || undefined,
          };
        })
      );

      setTaxonomyAnalyzing(true);

      const response = await api.post<InferTaxonomyResponse>('/api/data-lakes/infer-taxonomy', {
        folderTree: folderEntries,
        existingPrefix: options?.existingPrefix,
        context: options?.context,
      });

      return response.data;
    },
    onSuccess: data => {
      setTaxonomy({
        prefix: data.suggestedPrefix,
        suggestedName: data.suggestedName,
        tags: data.categories.map(cat => ({
          name: cat.tagName,
          strength: cat.confidence,
          source: 'ai' as const,
          sampleFileNames: cat.matchingFolders,
          deleted: false,
        })),
        analyzed: true,
        analyzing: false,
      });
      toast.success(`AI suggested ${data.categories.length} tag categories`);
    },
    onError: (error: Error) => {
      setTaxonomyAnalyzing(false);
      toast.error(error.message || 'Failed to infer taxonomy');
    },
  });
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
 * Slugify a string for use as a data lake slug.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Upload a single file to S3 using a presigned URL.
 */
async function uploadFileToS3(url: string, file: File): Promise<void> {
  await axios.put(url, file, {
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
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
        throw new Error('No internet connection — check your network and try again.');
      }

      // Read from store at mutation time to avoid stale closure
      // (same pattern as useComputeHashes)
      const { config, allFiles, targetLake } = useDataLakeWizardStore.getState();
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
      // Append mode reuses the target lake's slug; create mode derives it from the name.
      const slug = targetLake ? targetLake.slug : slugify(config.name);

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
          slug,
          description: config.description || undefined,
          fileTagPrefix: tagPrefix,
          requiredUserTag: config.requiredUserTag || undefined,
          requiredEntitlement: config.requiredEntitlement || undefined,
          ...(organizationId ? { organizationId } : {}),
        } satisfies CreateDataLakeRequestInputType);
        dataLakeId = dataLakeRes.data.id;
      }
      let uploadedCount = 0;

      // The lake record is created before files are uploaded, so any failure
      // below (e.g. an oversized file rejected at presign) would otherwise leave
      // an orphan empty lake. Roll it back if nothing uploaded.
      try {
        const totalSizeBytes = included.reduce((sum, f) => sum + f.size, 0);

        // Per-file tags derived from each file's source folder (one tag = its
        // folder/disease), so disease folders stay meaningful instead of every
        // file carrying every taxonomy tag. The lake meta-tag is added server-side.
        const appliedTags = Array.from(
          new Set(included.flatMap(f => folderTagForFile(f.relativePath, tagPrefix).map(t => t.name)))
        ).map(name => ({ name, strength: 1.0 }));

        // Step 2: Create batch record
        const batchRes = await api.post<{ id: string }>('/api/data-lakes/batches', {
          dataLakeId,
          totalFiles: included.length,
          totalSizeBytes,
          appliedTags,
        });

        const batchId = batchRes.data.id;

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
        });

        // Step 3: Request presigned URLs in chunks and upload
        let failedCount = 0;
        const failedNames: string[] = [];

        for (let i = 0; i < included.length; i += BATCH_CHUNK_SIZE) {
          const chunk = included.slice(i, i + BATCH_CHUNK_SIZE);

          const urlsRes = await api.post<{
            files: { fileId: string; fileKey: string; url: string; fileName: string }[];
          }>('/api/files/generate-presigned-urls-batch', {
            files: chunk.map(f => ({
              fileName: f.file.name,
              mimeType: f.type || 'application/octet-stream',
              fileSize: f.size,
              relativePath: f.relativePath,
              ...(f.contentHash && { contentHash: f.contentHash }),
              tags: folderTagForFile(f.relativePath, tagPrefix),
            })),
            dataLakeSlug: slug,
            // Correlate every uploaded file to its batch so the pipeline
            // (objectCreated -> chunk -> vectorize) updates batch progress and the
            // batch can complete. Also populates the batch manifest server-side.
            batchId,
          });

          // Upload files with concurrency limit
          const urlMap = urlsRes.data.files;

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

        // Update batch status: uploads done, now processing (chunking/vectorizing)
        await api.put(`/api/data-lakes/batches/${batchId}`, { status: 'processing' }).catch(() => {});

        updateUploadProgress({
          status: failedCount === included.length ? 'error' : 'complete',
        });

        queryClient.invalidateQueries({ queryKey: ['data-lakes'] });

        return { dataLakeId, batchId, uploadedCount, failedCount };
      } catch (err) {
        // Roll back ONLY a lake we just created - never delete the user's existing
        // lake in append mode. Nothing landed, so delete the empty new lake (best-effort).
        if (!targetLake && uploadedCount === 0) {
          await api.delete(`/api/data-lakes/${dataLakeId}`).catch(() => {});
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
      // A network failure (e.g. offline) never reaches the server, so it has no
      // response body - surface a friendly message instead of axios's raw
      // "Network Error".
      let message = 'Batch upload failed';
      if (axios.isAxiosError(error) && (error.code === 'ERR_NETWORK' || error.message === 'Network Error')) {
        message = 'No internet connection — check your network and try again.';
      } else if (error && typeof error === 'object') {
        const axiosData = (error as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
        if (axiosData?.data && typeof axiosData.data === 'object') {
          const data = axiosData.data as Record<string, unknown>;
          message = (data.error as string) || (data.message as string) || message;
        } else if ((error as Error).message) {
          message = (error as Error).message;
        }
      }
      updateUploadProgress({ status: 'error', errorMessage: message });
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
      const response = await api.get<{
        data: Array<{
          id: string;
          name: string;
          slug: string;
          description?: string;
          fileTagPrefix: string;
          requiredUserTag?: string;
          requiredEntitlement?: string;
          organizationId?: string;
          datalakeTag: string;
          fileCount?: number;
          createdAt: string;
        }>;
      }>('/api/data-lakes');
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
 * Hook: Remove a single file from a data lake (soft-delete + chunk teardown).
 * Owner/admin only; the server verifies the file actually belongs to the lake.
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
      // Refresh the lake list so the cached fileCount reflects the removal.
      queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to remove file from data lake');
    },
  });
}
