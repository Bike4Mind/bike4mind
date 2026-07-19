import { api } from '@client/app/contexts/ApiContext';
import {
  CreateFabFileRequestInputType,
  FileGeneratePresignedUrlResponseType,
  IFabFileDocument,
  UpdateFabFileRequestInputType,
} from '@bike4mind/common';
import { IShareableDocument } from '@bike4mind/common';
import axios from 'axios';
import { ActualFileObject } from 'filepond';
import type { fabFilesService } from '@bike4mind/services';
import { resizeImageFile, isImageFile } from './imageResizer';

export const getFabFilesFromServer = async (args?: fabFilesService.SearchFabFilesParameters) => {
  console.log('getFabFilesFromServer', args);
  const response = await api.get<{ data: IFabFileDocument[]; hasMore: boolean }>(`/api/files`, { params: args });
  return response.data;
};

export const getFabFilesFromServerByIds = async (ids: string[]) => {
  const response = await api.get<IFabFileDocument[]>(`/api/files/byIds`, { params: { ids } });
  return response.data;
};

export const chunkFabFileFromServer = async (fabFileId: string, chunkSize: number) => {
  const response = await api.post(`/api/files/chunk`, {
    fabFileId,
    chunkSize,
  });
  return response.data;
};

export const updateFabFileOnServer = async (
  fabFileId: string,
  updatedFabFileData: UpdateFabFileRequestInputType
): Promise<IFabFileDocument> => {
  const response = await api.put<IFabFileDocument>(`/api/files/${fabFileId}`, {
    ...updatedFabFileData,
  });
  return response.data;
};

export const createFabFileOnServer = async (
  formData: CreateFabFileRequestInputType
): Promise<IFabFileDocument & IShareableDocument> => {
  const response = await api.post<IFabFileDocument & IShareableDocument>('/api/files/createFabFile', formData);
  return response.data;
};

export const createFabFileOnServerWithUpload = async (
  formData: CreateFabFileRequestInputType,
  file: ActualFileObject | File,
  abortSignal?: AbortSignal,
  onProgress?: (loaded: number, total: number) => void
): Promise<IFabFileDocument & IShareableDocument> => {
  let fileToUpload = file;

  // Resize image if it's too large (client-side optimization)
  if (file instanceof File && isImageFile(file)) {
    const originalSize = file.size / (1024 * 1024);
    console.log(`[Upload] Image file detected: ${originalSize.toFixed(2)}MB`);

    // Resize if larger than 3MB to ensure compatibility with Anthropic (3.5MB limit)
    if (originalSize > 3) {
      console.log(`[Upload] Image exceeds 3MB, resizing on client...`);
      fileToUpload = await resizeImageFile(file, {
        maxSizeMB: 3,
        maxWidthOrHeight: 2048,
        quality: 0.9,
      });
      const newSize = fileToUpload.size / (1024 * 1024);
      console.log(`[Upload] Image resized from ${originalSize.toFixed(2)}MB to ${newSize.toFixed(2)}MB`);

      // Update formData with new file size
      formData = {
        ...formData,
        fileSize: fileToUpload.size,
      };
    }
  }

  const newFabFile = await createFabFileOnServer(formData);

  try {
    // Check if already aborted before starting upload
    if (abortSignal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }

    // If the a file has a presigned URL, upload the file to the bucket
    if (newFabFile.presignedUrl) {
      const putConfig = {
        headers: {
          'Content-Type': fileToUpload.type,
        },
        signal: abortSignal,
        onUploadProgress: onProgress
          ? (progressEvent: { total?: number; loaded: number }) => {
              const total = progressEvent.total || fileToUpload.size;
              const loaded = progressEvent.loaded;
              onProgress(loaded, total);
            }
          : undefined,
      };
      // Self-host returns a same-origin proxy path (leading '/') that needs the app's auth;
      // the hosted S3 presign is an absolute, self-authenticating URL. Route the proxy through
      // the authenticated `api` client, the S3 presign through raw axios (no app auth/cookies).
      if (newFabFile.presignedUrl.startsWith('/')) {
        await api.put(newFabFile.presignedUrl, fileToUpload, putConfig);
      } else {
        await axios.put(newFabFile.presignedUrl, fileToUpload, putConfig);
      }

      // Check abort before presigned URL generation
      if (abortSignal?.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }

      // After successful upload, generate a signed URL for viewing the file
      if (newFabFile.filePath) {
        const presignedUrlResponse = await api.get('/api/files/presigned-url', {
          params: {
            filePaths: [newFabFile.filePath],
            expiresIn: 3600,
          },
          signal: abortSignal,
        });

        if (
          presignedUrlResponse.data.urls &&
          presignedUrlResponse.data.urls.length > 0 &&
          presignedUrlResponse.data.urls[0]
        ) {
          // Update the FabFile with the viewing URL
          const updatedFabFile = {
            ...newFabFile,
            fileUrl: presignedUrlResponse.data.urls[0],
            fileUrlExpireAt: new Date(Date.now() + 3600 * 1000), // 1 hour from now
          };
          return updatedFabFile;
        }
      }
    }
    return newFabFile;
  } catch (err) {
    // Clean up partial file if upload was aborted
    // Check for both DOMException and axios cancel errors
    const isAborted =
      (err instanceof DOMException && err.name === 'AbortError') ||
      axios.isCancel(err) ||
      (err as any)?.code === 'ERR_CANCELED';

    if (isAborted) {
      // Silently clean up the created FabFile record
      try {
        await api.delete(`/api/files/${newFabFile.id}`);
      } catch (cleanupError) {
        console.warn('Failed to clean up aborted upload:', cleanupError);
      }
      throw new DOMException('Upload cancelled', 'AbortError'); // Always throw DOMException for consistency
    }
    throw new Error('Failed to upload fab file');
  }
};

export const createAppFileOnServerWithUpload = async (
  formData: CreateFabFileRequestInputType,
  file: ActualFileObject | File,
  abortSignal?: AbortSignal
): Promise<string> => {
  let fileToUpload = file;

  // Resize image if it's too large (client-side optimization)
  if (file instanceof File && isImageFile(file)) {
    const originalSize = file.size / (1024 * 1024);
    console.log(`[Upload] App file image detected: ${originalSize.toFixed(2)}MB`);

    // Resize if larger than 3MB to ensure compatibility with Anthropic (3.5MB limit)
    if (originalSize > 3) {
      console.log(`[Upload] Image exceeds 3MB, resizing on client...`);
      fileToUpload = await resizeImageFile(file, {
        maxSizeMB: 3,
        maxWidthOrHeight: 2048,
        quality: 0.9,
      });
      const newSize = fileToUpload.size / (1024 * 1024);
      console.log(`[Upload] Image resized from ${originalSize.toFixed(2)}MB to ${newSize.toFixed(2)}MB`);

      // Update formData with new file size
      formData = {
        ...formData,
        fileSize: fileToUpload.size,
      };
    }
  }

  const response = await api.post<FileGeneratePresignedUrlResponseType>(
    '/api/app-files/generate-presigned-url',
    formData
  );

  const { url: presignedUrl, fileId } = response.data;
  await axios.put(presignedUrl, fileToUpload, {
    headers: {
      'Content-Type': fileToUpload.type,
    },
  });

  try {
    // Check if already aborted before starting upload
    if (abortSignal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }

    await axios.put(presignedUrl, file, {
      headers: {
        'Content-Type': file.type,
      },
      signal: abortSignal,
    });

    return fileId;
  } catch (err) {
    // Clean up partial file if upload was aborted
    // Check for both DOMException and axios cancel errors
    const isAborted =
      (err instanceof DOMException && err.name === 'AbortError') ||
      axios.isCancel(err) ||
      (err as any)?.code === 'ERR_CANCELED';

    if (isAborted) {
      // App files may not have a cleanup endpoint, but still throw the error
      throw new DOMException('Upload cancelled', 'AbortError'); // Always throw DOMException for consistency
    }
    throw err;
  }
};

export const createFabFileOnServerURL = async (data: {
  url: string;
}): Promise<IFabFileDocument | IShareableDocument> => {
  const response = await api.post<IFabFileDocument | IShareableDocument>('/api/files/createFabFileURL', data);
  return response.data;
};

export const deleteFileUtility = async (fileId: string): Promise<boolean> => {
  // Skip API call for temp IDs that were never persisted to the server
  if (fileId.startsWith('temp-')) {
    return true;
  }

  try {
    await api.delete(`/api/files/${fileId}`);
    console.log('File deleted successfully');
    return true;
  } catch (err) {
    console.error('Failed to delete the file:', err);
    return false; // Return false if an error occurred during the deletion process
  }
};

export const chunkFileUtility = async (fabFileId: string, chunkSize: number) => {
  try {
    await chunkFabFileFromServer(fabFileId, chunkSize);
  } catch (err: any) {
    console.error('Failed to chunk the file:', err);
  }
};

export const getFabFileByIdFromServer = async (fabFileId: string): Promise<IFabFileDocument> => {
  const response = await api.get<IFabFileDocument>(`/api/files/${fabFileId}`);

  if (response.status === 200 && response.data) {
    return response.data;
  } else {
    throw new Error(`Failed to fetch FabFile with ID ${fabFileId}`);
  }
};

export const getFabFileNameByIdFromServer = async (fabFileId: string): Promise<string> => {
  const response = await api.get<{ name: string }>(`/api/files/getFabFileNameById`, {
    params: { fabFileId },
  });
  return response.data.name;
};

export const updateFileUtility = async (fabFileId: string, updatedFabFileData: UpdateFabFileRequestInputType) => {
  try {
    const response = await updateFabFileOnServer(fabFileId, updatedFabFileData);
    console.log('Update response from server:', response);
    return response;
  } catch (err: any) {
    console.error('Failed to update Fab file:', err);
    throw err; // Re-throw the error to be handled by the caller
  }
};

export const getContentFromFabfile = async (file: IFabFileDocument): Promise<Response> => {
  if (!file.fileUrl) throw new Error('File URL is undefined');
  const response = await fetch(file.fileUrl as string);
  return response;
};

export const copyGeneratedImageToFabFile = async (
  imageS3Key: string,
  fileName?: string
): Promise<IFabFileDocument & IShareableDocument> => {
  const response = await api.post<IFabFileDocument & IShareableDocument>('/api/files/copy-generated-image', {
    imageS3Key,
    fileName,
  });
  return response.data;
};
