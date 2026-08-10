import { useEffect, useRef } from 'react';
import type { IMessageDataToClient } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useDataLakeWizardStore, type UploadProgress } from '@client/app/stores/useDataLakeWizardStore';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import { computeFileHash } from '@client/app/utils/folderTreeParser';
import { invalidateGearsStatusWhileLocked } from '@client/app/hooks/useGearsStatus';
import {
  runWithConcurrency,
  OFFLINE_MESSAGE,
  classifyUploadError,
  runBatchUpload,
} from '@client/app/hooks/data/dataLakeUploadPipeline';

// Re-exported for DataLakeWizardModal's pre-flight check, which imports it from this path.
export { OFFLINE_MESSAGE };

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

      await runWithConcurrency(included, HASH_CONCURRENCY, async file => {
        try {
          const hash = await computeFileHash(file.file);
          setFileHash(file.relativePath, hash);
          completed++;
          updateHashingProgress({ completed });
        } catch {
          // If hashing fails, skip; file will upload without dedup
          completed++;
          updateHashingProgress({ completed });
        }
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

      return runBatchUpload({
        updateUploadProgress,
        setStep,
        onUploadComplete: () => {
          queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
          // First lake unlocks the 'datalakes' nav slot; first file unlocks 'files'.
          // Reveal them without waiting out the gears/status staleTime (#833).
          invalidateGearsStatusWhileLocked(queryClient, ['datalakes', 'files']);
        },
      });
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
      const { config, targetLake } = useDataLakeWizardStore.getState();
      const { kind, message } = classifyUploadError(error, {
        config: { name: config.name, tagPrefix: config.tagPrefix },
        isAppend: !!targetLake,
      });
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
      if (message.processingFailedFiles !== undefined) {
        updates.processingFailedFiles = message.processingFailedFiles;
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
