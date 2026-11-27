import { Logger } from '@bike4mind/observability';
import { IFabFileRepository, IProjectRepository, IUserRepository, isImageServeable } from '@bike4mind/common';
import {
  NotFoundError,
  secureParameters,
  BaseStorage,
  fileUrlSigningDate,
  fileContentExp,
  FILE_URL_TTL_SECONDS,
} from '@bike4mind/utils';
import { z } from 'zod';
import { storageReadOverrides } from '@bike4mind/utils/contentDisposition';
import { signedUrlExpiresAt, type GetFabFileAdapter } from '../fabFileService/get';

const listProjectFilesSchema = z.object({
  projectId: z.string(),
});

type ListProjectFilesParameters = z.infer<typeof listProjectFilesSchema>;

interface ListProjectFilesAdapters {
  db: {
    projects: IProjectRepository;
    files: IFabFileRepository;
    users: IUserRepository;
  };
  storage?: BaseStorage;
  contentUrl?: GetFabFileAdapter['storage']['contentUrl'];
}

export const listFiles = async (
  userId: string,
  params: ListProjectFilesParameters,
  adapters: ListProjectFilesAdapters
) => {
  const { projectId } = secureParameters(params, listProjectFilesSchema);

  const user = await adapters.db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const project = await adapters.db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new NotFoundError('Project not found');

  // Listed in the project is not a grant: only files the caller can still read.
  const readable = new Set(
    (await adapters.db.files.shareable.findAllAccessibleByIds(user, project.fileIds)).map(file => String(file.id))
  );
  const files = (await adapters.db.files.findAllByIds(project.fileIds)).filter(file => readable.has(String(file.id)));

  // Sign on read: URLs are response-only and never stored
  if (adapters.storage) {
    const filesWithUrls = await Promise.all(
      files.map(async file => {
        // never mint a GET URL for an image that's still held (pending
        // scan) or was quarantined (blocked) by upload moderation. Mirrors generateSignedUrl
        // in fabFileService/get.ts - withhold the URL but return the record (moderationStatus
        // intact) so the client can render a "Scanning..."/blocked placeholder instead of the
        // file silently vanishing from the project files listing.
        if (!isImageServeable(file)) {
          file.fileUrl = undefined;
          file.fileUrlExpireAt = undefined;
          return file;
        }

        file.fileUrl = undefined;
        file.fileUrlExpireAt = undefined;
        if (file.filePath && adapters.contentUrl && file.id) {
          const exp = fileContentExp();
          file.fileUrl = adapters.contentUrl({ id: file.id, filePath: file.filePath }, exp);
          file.fileUrlExpireAt = new Date(exp * 1000);
        } else if (file.filePath) {
          try {
            file.fileUrl = await adapters.storage!.getSignedUrl(file.filePath, 'get', {
              expiresIn: FILE_URL_TTL_SECONDS,
              signingDate: fileUrlSigningDate(),
              ...storageReadOverrides({ mimeType: file.mimeType, fileName: file.fileName, key: file.filePath }),
            });
            file.fileUrlExpireAt = signedUrlExpiresAt(file.fileUrl, FILE_URL_TTL_SECONDS);
          } catch (error) {
            Logger.globalInstance.error(`Failed to generate presigned URL for file ${file.id}:`, error);
            // Continue without URL rather than failing the entire request
          }
        }
        return file;
      })
    );
    return filesWithUrls;
  }

  return files;
};
