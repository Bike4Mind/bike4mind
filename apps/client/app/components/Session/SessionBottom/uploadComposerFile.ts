import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import {
  IFabFileDocument,
  KnowledgeType,
  isImageAttachment,
  resolveAttachScope,
  type AttachScopeMode,
} from '@bike4mind/common';
import { createFabFileOnServerWithUpload, deleteFileUtility } from '@client/app/utils/filesAPICalls';
import { getErrorMessage, sanitizeErrorMessage } from '@client/app/utils/error';
import {
  setPendingMessageFiles,
  consumeBufferedModerationStatus,
  patchPendingMessageFileModerationStatus,
} from '@client/app/hooks/useSessionLayout';
import { GearsStatusResponse } from '@client/app/hooks/useGearsStatus';
import { useUser } from '@client/app/contexts/UserContext';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import {
  StorageLimitExceededError,
  checkAttachStorage,
  checkAttachStorageFresh,
  getStorageQuota,
  storageLimitMessage,
  storageNearLimitMessage,
} from '@client/app/utils/storageQuota';

export interface ComposerUploadContext {
  attachScopeMode: AttachScopeMode;
  currentSessionId: string | null;
  addToNotebookContext: (
    sessionId: string | null,
    fabFile: IFabFileDocument,
    options?: { propagateToProjects?: boolean }
  ) => Promise<boolean>;
  queryClient: QueryClient;
}

interface UploadComposerFileOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  /** The name to upload under, when it is still being worked out; the tile shows `file.name` until then. */
  fileName?: Promise<string>;
}

// A first upload unlocks the 'files' gear server-side, but the Gears status
// query has a 5-minute staleTime - without an explicit invalidation the Gears
// page keeps showing the unearned "Upload your first file" CTA until a reload.
// Only invalidate while the gear is still locked so routine uploads don't
// refetch the status on every attachment.
function invalidateGearsStatusOnFirstFile(queryClient: QueryClient) {
  const status = queryClient.getQueryData<GearsStatusResponse>(['gears', 'status']);
  const filesGear = status?.gears.find(g => g.key === 'files');
  if (!filesGear || filesGear.unlocked) return;
  void queryClient.invalidateQueries({ queryKey: ['gears', 'status'] });
}

// Toasted on top of the tile's own message for its "Manage files" action. One id so a
// multi-file drop shows one toast.
function toastStorageLimit(message: string) {
  toast.error(message, {
    id: 'storage-limit-exceeded',
    duration: 10000,
    action: { label: 'Manage files', onClick: () => useFileBrowser.getState().setOpen(true) },
  });
}

// Keyed by the pending item's temp id, so removing its tile can cancel the upload.
const inFlightUploads = new Map<string, AbortController>();

/** Cancel a composer upload that has not resolved yet; a no-op for any other id. */
export const cancelComposerUpload = (tempId: string) => inFlightUploads.get(tempId)?.abort();

// A raw string body is an S3 XML error or a gateway HTML page, not a message for the user.
const uploadErrorMessage = (err: unknown) =>
  isAxiosError(err) && typeof err.response?.data === 'string' ? undefined : sanitizeErrorMessage(getErrorMessage(err));

/**
 * Upload a file attached in the chat composer (drop, picker or paste) as a pending
 * message thumbnail. Rejects on failure: the thumbnail is removed if the upload was
 * aborted (`signal` or cancelComposerUpload), otherwise marked as errored.
 */
export async function uploadComposerFile(
  file: File,
  { attachScopeMode, currentSessionId, addToNotebookContext, queryClient }: ComposerUploadContext,
  { signal, onProgress, fileName }: UploadComposerFileOptions = {}
): Promise<IFabFileDocument> {
  // Each file is judged alone; files of one drop that only overflow together are
  // refused by the server, whose message the catch below surfaces.
  const storageCheck = checkAttachStorage(getStorageQuota(useUser.getState().currentUser), file);
  if (storageCheck.status === 'near') {
    toast.warning(storageNearLimitMessage(storageCheck), { id: 'storage-near-limit' });
  }

  const tempId = `temp-${Date.now()}-${Math.random()}`;
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  inFlightUploads.set(tempId, controller);

  // Frozen for the life of this upload, so a notebook switch or a scope-mode change
  // mid-flight can't re-scope a file that is already uploading.
  const uploadSessionId = currentSessionId;
  const scope = resolveAttachScope(attachScopeMode, file.type);

  setPendingMessageFiles(prev => [
    ...prev,
    {
      fabFile: {
        id: tempId,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      } as IFabFileDocument,
      uploadProgress: 0,
      status: 'uploading',
      scope,
      uploadSessionId,
      localFile: file,
      clientId: tempId,
    },
  ]);

  try {
    controller.signal.throwIfAborted();

    let upload = file;
    if (fileName) {
      const name = await fileName;
      controller.signal.throwIfAborted();
      upload = new File([file], name, { type: file.type });
      setPendingMessageFiles(prev =>
        prev.map(item =>
          item.fabFile.id === tempId ? { ...item, fabFile: { ...item.fabFile, fileName: name } } : item
        )
      );
    }

    const freshCheck = await checkAttachStorageFresh(upload);
    if (freshCheck.status === 'exceeds') throw new StorageLimitExceededError(freshCheck);

    const lowerName = upload.name.toLowerCase();
    const mimeType = lowerName.endsWith('.md') || lowerName.endsWith('.mdx') ? 'text/markdown' : upload.type;

    const fabFile = await createFabFileOnServerWithUpload(
      {
        type: KnowledgeType.FILE,
        fileName: upload.name,
        mimeType,
        fileSize: upload.size,
      },
      upload,
      controller.signal,
      (loaded, total) => {
        const progressPercent = Math.round((loaded / total) * 100);
        setPendingMessageFiles(prev =>
          prev.map(item => (item.fabFile.id === tempId ? { ...item, uploadProgress: progressPercent } : item))
        );
        onProgress?.(loaded, total);
      }
    );

    if (controller.signal.aborted) {
      // Cancelled after the server already had the file; filesAPICalls only cleans up mid-request.
      void deleteFileUtility(fabFile.id).catch(() => {});
      controller.signal.throwIfAborted();
    }

    // Images land in 'scanning' (not optimistic 'complete') because the async
    // content-moderation scan hasn't resolved yet; the image_moderation_status
    // websocket event flips it to clean/blocked.
    const isImageUpload = isImageAttachment(fabFile.mimeType);

    // Consume the buffer BEFORE the state update, not inside the updater.
    // The WS handler promotes notebook-scoped images once they clear, but it
    // matches on the real FabFile id - and when the scan beat this swap the
    // event was buffered instead, so that lookup found nothing. This is the
    // only remaining chance to see it.
    const buffered = isImageUpload ? consumeBufferedModerationStatus(fabFile.id) : undefined;

    setPendingMessageFiles(prev => {
      const withRealFile = prev.map(item =>
        item.fabFile.id === tempId
          ? {
              // Spread first: `scope` was frozen when the upload started and
              // must survive the temp-id -> real-FabFile swap.
              ...item,
              fabFile,
              uploadProgress: 100,
              status: isImageUpload ? ('scanning' as const) : ('complete' as const),
            }
          : item
      );

      if (!buffered) return withRealFile;

      return patchPendingMessageFileModerationStatus(
        withRealFile,
        fabFile.id,
        buffered.moderationStatus,
        buffered.fileUrl
      );
    });

    // A document joins notebook context as soon as the upload resolves.
    // An image only gets here when the user explicitly chose 'notebook';
    // its write is deferred until moderation clears, because a knowledgeIds
    // entry propagates into clones, exports and (opt-in) projects, and a
    // blocked image must never reach any of those.
    //
    // propagateToProjects is false: landing in notebook context by default
    // is consent to THIS notebook, not to every project containing it.
    if (scope === 'notebook' && (!isImageUpload || buffered?.moderationStatus === 'clean')) {
      // The upload response still carries the schema-default 'pending'; the hook's scan
      // guard would refuse it, and the consumed buffered event never fires again.
      const promotedFile =
        isImageUpload && buffered
          ? {
              ...fabFile,
              moderationStatus: buffered.moderationStatus,
              ...(buffered.fileUrl ? { fileUrl: buffered.fileUrl } : {}),
            }
          : fabFile;
      void addToNotebookContext(uploadSessionId, promotedFile, { propagateToProjects: false }).catch(() => {
        // Already rolled back and surfaced by the hook.
      });
    }

    invalidateGearsStatusOnFirstFile(queryClient);

    return fabFile;
  } catch (err) {
    // Axios rejects a cancelled request with its own error type, so trust the signal.
    if (controller.signal.aborted) {
      setPendingMessageFiles(prev => prev.filter(item => item.fabFile.id !== tempId));
      throw err;
    }

    console.error('Error creating fab file:', err);
    const storageMessage = storageLimitMessage(err);
    setPendingMessageFiles(prev =>
      prev.map(item =>
        item.fabFile.id === tempId
          ? {
              ...item,
              status: 'error' as const,
              errorMessage: storageMessage ?? uploadErrorMessage(err),
            }
          : item
      )
    );
    if (storageMessage) toastStorageLimit(storageMessage);
    throw err;
  } finally {
    inFlightUploads.delete(tempId);
  }
}
