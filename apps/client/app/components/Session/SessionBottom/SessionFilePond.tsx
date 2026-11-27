import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box } from '@mui/joy';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import 'filepond/dist/filepond.min.css';
import { FilePond } from 'react-filepond';
import { deleteFileUtility } from '@client/app/utils/filesAPICalls';
import { ComposerUploadContext, uploadComposerFile } from './uploadComposerFile';
import styles from '../FilePond.module.css';

// any: FilePond types are not fully compatible with React 18 generics
const FilePondComponent = FilePond as any;

interface SessionFilePondProps extends Omit<ComposerUploadContext, 'queryClient'> {
  pond: React.RefObject<any>;
  files: any[];
  setFiles: React.Dispatch<React.SetStateAction<any[]>>;
  maxFileSizeForFilePond: string;
}

export function SessionFilePond({
  pond,
  files,
  setFiles,
  maxFileSizeForFilePond,
  attachScopeMode,
  currentSessionId,
  addToNotebookContext,
}: SessionFilePondProps) {
  const queryClient = useQueryClient();

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
            const abortController = new AbortController();

            uploadComposerFile(
              file,
              { attachScopeMode, currentSessionId, addToNotebookContext, queryClient },
              { signal: abortController.signal, onProgress: (loaded, total) => progress(true, loaded, total) }
            )
              .then(fabFile => {
                load(fabFile.id);

                // Clear FilePond file after short delay (same for both modes)
                setTimeout(() => {
                  setFiles(prevFiles => prevFiles.filter(f => f.file !== file));
                }, 500);
              })
              .catch((err: unknown) => {
                if (abortController.signal.aborted) {
                  console.log('Upload cancelled by user:', file.name);
                  return;
                }
                // Cancelled from its tile: drop the hidden item so it does not count against maxFiles.
                if (err instanceof DOMException && err.name === 'AbortError') {
                  setFiles(prevFiles => prevFiles.filter(f => f.file !== file));
                  return;
                }
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
