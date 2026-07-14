import React from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Box } from '@mui/joy';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import 'filepond/dist/filepond.min.css';
import { FilePond } from 'react-filepond';
import { IFabFileDocument, ISessionDocument, KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload, deleteFileUtility } from '@client/app/utils/filesAPICalls';
import {
  setPendingMessageFiles,
  consumeBufferedModerationStatus,
  patchPendingMessageFileModerationStatus,
} from '@client/app/hooks/useSessionLayout';
import { GearsStatusResponse } from '@client/app/hooks/useGearsStatus';
import { LexicalChatInputRef } from '../LexicalChatInput';
import styles from '../FilePond.module.css';

// any: FilePond types are not fully compatible with React 18 generics
const FilePondComponent = FilePond as any;

interface SessionFilePondProps {
  pond: React.RefObject<any>;
  files: any[];
  setFiles: React.Dispatch<React.SetStateAction<any[]>>;
  maxFileSizeForFilePond: string;
  isSessionFileMode: boolean;
  currentSessionId: string | null;
  currentSession: ISessionDocument | null;
  setWorkBenchFiles: (
    sessionId: string,
    files: IFabFileDocument[] | ((prev: IFabFileDocument[]) => IFabFileDocument[])
  ) => void;
  setCurrentSession: (session: ISessionDocument) => void;
  lexicalInputRef: React.RefObject<LexicalChatInputRef | null>;
  chatInputValue: string;
  setChatInputValue: (value: string) => void;
}

export function SessionFilePond({
  pond,
  files,
  setFiles,
  maxFileSizeForFilePond,
  isSessionFileMode,
  currentSessionId,
  currentSession,
  setWorkBenchFiles,
  setCurrentSession,
  lexicalInputRef,
  chatInputValue,
  setChatInputValue,
}: SessionFilePondProps) {
  const queryClient = useQueryClient();

  // A first upload unlocks the 'files' gear server-side, but the Gears status
  // query has a 5-minute staleTime - without an explicit invalidation the Gears
  // page keeps showing the unearned "Upload your first file" CTA until a reload.
  // Only invalidate while the gear is still locked so routine uploads don't
  // refetch the status on every attachment.
  const invalidateGearsStatusOnFirstFile = () => {
    const status = queryClient.getQueryData<GearsStatusResponse>(['gears', 'status']);
    const filesGear = status?.gears.find(g => g.key === 'files');
    if (!filesGear || filesGear.unlocked) return;
    void queryClient.invalidateQueries({ queryKey: ['gears', 'status'] });
  };

  return (
    <Box
      sx={{
        display: 'none', // Hide FilePond completely - using thumbnails instead
        '& .filepond--root': {
          height: '0px !important',
          marginBottom: '0px !important',
        },
        '& .filepond--panel-root': {
          backgroundColor: 'inherit',
        },
        '& .filepond--credits': {
          marginTop: '0px !important',
          display: 'none !important',
        },
      }}
    >
      <FilePondComponent
        ref={pond}
        files={files}
        onupdatefiles={setFiles}
        maxFileSize={maxFileSizeForFilePond}
        allowMultiple={true}
        dropOnPage={false}
        allowPaste={true}
        labelIdle={'<span class="filepond--label-action"></span>'}
        stylePanelLayout="compact" // If I use "integrated then the file upload does not complete"
        className={styles.bike4mind}
        maxFiles={20}
        name="content"
        server={{
          process: (
            fieldName: string,
            file: File,
            metadata: unknown,
            load: (fileId: string | number) => void,
            error: (message: string) => void,
            progress: (computable: boolean, loaded: number, total: number) => void,
            abort: () => void
          ) => {
            // Create AbortController for this upload
            const abortController = new AbortController();

            // Create temporary ID for this upload
            const tempId = `temp-${Date.now()}-${Math.random()}`;

            // Immediately add to thumbnails with uploading status
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
              },
            ]);

            file
              .arrayBuffer()
              .then(() => {
                // Check if aborted during file read
                if (abortController.signal.aborted) {
                  throw new DOMException('Upload cancelled', 'AbortError');
                }

                // Determine proper MIME type for markdown files
                let mimeType = file.type;

                // Set MIME type based on file extension
                if (file.name.toLowerCase().endsWith('.md') || file.name.toLowerCase().endsWith('.mdx')) {
                  console.log('Setting MIME type to text/markdown for .md/.mdx file');
                  mimeType = 'text/markdown';
                }

                const data = {
                  type: KnowledgeType.FILE,
                  fileName: file.name,
                  mimeType: mimeType,
                  fileSize: file.size,
                };
                // Pass abort signal to upload function
                return createFabFileOnServerWithUpload(data, file, abortController.signal, (loaded, total) => {
                  // Update progress in thumbnail
                  const progressPercent = Math.round((loaded / total) * 100);
                  setPendingMessageFiles(prev =>
                    prev.map(item => (item.fabFile.id === tempId ? { ...item, uploadProgress: progressPercent } : item))
                  );
                  // Also update FilePond progress
                  progress(true, loaded, total);
                });
              })
              // any: createFabFileOnServerWithUpload returns IFabFileDocument but promise chain loses type
              .then((fabFile: any) => {
                // Check one final time before completing
                if (abortController.signal.aborted) {
                  throw new DOMException('Upload cancelled', 'AbortError');
                }

                // Replace temporary file with actual FabFile. Images land in 'scanning' (not
                // optimistic 'complete') because the async S3-upload content-moderation scan
                // hasn't resolved yet - GetFileIcon shows the scanning placeholder
                // until the image_moderation_status websocket event flips it to clean/blocked.
                const isImageUpload = typeof fabFile.mimeType === 'string' && fabFile.mimeType.startsWith('image/');
                setPendingMessageFiles(prev => {
                  const withRealFile = prev.map(item =>
                    item.fabFile.id === tempId
                      ? {
                          fabFile,
                          uploadProgress: 100,
                          status: isImageUpload ? ('scanning' as const) : ('complete' as const),
                        }
                      : item
                  );

                  if (!isImageUpload) return withRealFile;

                  // The image_moderation_status websocket event can arrive before this
                  // temp-id -> real-FabFile-id swap resolves (a race) - the
                  // subscriber can't match it to a pending item yet and buffers it by
                  // fabFileId instead. Replay it now so the item doesn't get stuck on the
                  // 'scanning' placeholder set just above.
                  const buffered = consumeBufferedModerationStatus(fabFile.id);
                  if (!buffered) return withRealFile;

                  return patchPendingMessageFileModerationStatus(
                    withRealFile,
                    fabFile.id,
                    buffered.moderationStatus,
                    buffered.fileUrl
                  );
                });

                // CONDITIONAL: Only session mode adds to workBenchFiles and auto-tags
                if (isSessionFileMode) {
                  setWorkBenchFiles(currentSessionId ?? '', prev => {
                    const newWorkBenchFiles = [...prev, fabFile];
                    // If we have a current session, update its knowledgeIds
                    if (currentSession) {
                      const knowledgeIds = newWorkBenchFiles.map((f: IFabFileDocument) => f.id);
                      // Create new session object to trigger persistence
                      setCurrentSession({ ...currentSession, knowledgeIds });
                    }
                    return newWorkBenchFiles;
                  });

                  // Add file reference tag to the input (session mode only)
                  const fileTag = `[[${fabFile.fileName}]]`;
                  if (lexicalInputRef.current) {
                    try {
                      lexicalInputRef.current.insertContent(fileTag);
                    } catch (insertError) {
                      console.error('Failed to insert file tag:', insertError);
                      toast.error('Failed to add file reference to input');
                      // Fallback to string concatenation
                      const newValue = chatInputValue.trim() ? `${chatInputValue.trim()}\n\n${fileTag}` : fileTag;
                      setChatInputValue(newValue);
                    }
                  } else {
                    // Fallback for backward compatibility
                    const newValue = chatInputValue.trim() ? `${chatInputValue.trim()}\n\n${fileTag}` : fileTag;
                    setChatInputValue(newValue);
                  }
                }

                invalidateGearsStatusOnFirstFile();

                load(fabFile.id);

                // Clear FilePond file after short delay (same for both modes)
                setTimeout(() => {
                  setFiles(prevFiles => prevFiles.filter(f => f.file !== file));
                }, 500);
              })
              // any: catch receives unknown error types
              .catch((err: any) => {
                // Don't show error for user-initiated cancellations
                if (err instanceof DOMException && err.name === 'AbortError') {
                  console.log('Upload cancelled by user:', file.name);
                  // Remove from pending files on cancel
                  setPendingMessageFiles(prev => prev.filter(item => item.fabFile.id !== tempId));
                  return; // Silent cancellation
                }

                console.error('Error creating fab file:', err);
                // Update thumbnail to show error state
                setPendingMessageFiles(prev =>
                  prev.map(item => (item.fabFile.id === tempId ? { ...item, status: 'error' as const } : item))
                );
                error('Failed to upload file');
              });

            // CRITICAL: Return abort function to FilePond
            return {
              abort: () => {
                if (abortController.signal.aborted) {
                  console.log('Upload already cancelled for file:', file.name);
                  return;
                }
                console.log('Aborting upload for file:', file.name);
                abortController.abort();
                // Remove from pending files on abort
                setPendingMessageFiles(prev => prev.filter(item => item.fabFile.id !== tempId));
                // Let FilePond handle UI updates via onupdatefiles callback
                // Manual setFiles causes race conditions with rapid cancels
              },
            };
          },
          // any: FilePond revert callback uses untyped fileId
          revert: (fileId: any, load: () => void, error: (message: string) => void) => {
            // Skip API call for temp IDs that were never persisted to the server
            if (typeof fileId === 'string' && fileId.startsWith('temp-')) {
              load();
              return;
            }
            deleteFileUtility(fileId)
              .then(() => {
                load();
              })
              .catch(err => {
                console.error(err);
                error(err.message);
              });
          },
        }}
      />
    </Box>
  );
}
