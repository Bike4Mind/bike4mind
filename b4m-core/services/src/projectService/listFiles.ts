import { Logger } from '@bike4mind/observability';
import { IFabFileRepository, IProjectRepository, IUserRepository, isImageServeable } from '@bike4mind/common';
import { NotFoundError, secureParameters, BaseStorage } from '@bike4mind/utils';
import { z } from 'zod';

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

  const files = await adapters.db.files.findAllByIds(project.fileIds);

  // Generate presigned URLs for files that need them
  if (adapters.storage) {
    const filesWithUrls = await Promise.all(
      files.map(async file => {
        // never mint/persist a GET URL for an image that's still held (pending
        // scan) or was quarantined (blocked) by upload moderation. Mirrors generateSignedUrl
        // in fabFileService/get.ts - withhold the URL but return the record (moderationStatus
        // intact) so the client can render a "Scanning..."/blocked placeholder instead of the
        // file silently vanishing from the project files listing.
        if (!isImageServeable(file)) {
          file.fileUrl = undefined;
          file.fileUrlExpireAt = undefined;
          return file;
        }

        // Only generate URL if filePath exists and URL is missing or expired
        if (file.filePath && (!file.fileUrl || !file.fileUrlExpireAt || file.fileUrlExpireAt < new Date())) {
          try {
            const expiresIn = 3600; // 1 hour
            file.fileUrl = await adapters.storage!.getSignedUrl(file.filePath, 'get', { expiresIn });
            file.fileUrlExpireAt = new Date(Date.now() + expiresIn * 1000);

            await adapters.db.files.update({
              id: file.id,
              fileUrl: file.fileUrl,
              fileUrlExpireAt: file.fileUrlExpireAt,
            });
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
