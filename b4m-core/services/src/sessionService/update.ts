import { Logger } from '@bike4mind/observability';
import { updateShareableFiles } from '../projectService';
import {
  ICacheRepository,
  IFabFileRepository,
  IProjectRepository,
  isImageServeable,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { BaseStorage, getCachedSignedUrl } from '@bike4mind/utils';
import uniq from 'lodash/uniq.js';
import isEqual from 'lodash/isEqual.js';
import { z } from 'zod';

const updateSessionParamtersSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  tags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
  lastUsedModel: z.string().optional(),
});

type UpdateSessionParameters = z.infer<typeof updateSessionParamtersSchema>;

interface UpdateSessionAdapters {
  db: {
    sessions: ISessionRepository;
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
    caches: ICacheRepository;
  };
  storage: BaseStorage;
}

export const updateSession = async (
  user: IUserDocument,
  parameters: UpdateSessionParameters,
  adapters: UpdateSessionAdapters
) => {
  const { db } = adapters;
  const { knowledgeIds, artifactIds, name, id, tags, lastUsedModel } = secureParameters(
    parameters,
    updateSessionParamtersSchema
  );
  const session = await db.sessions.shareable.findUpdateAccessById(user, id);

  if (!session) {
    throw new NotFoundError('Session not found');
  }

  // If the knowledge IDs have changed, we need to update the projects
  if (knowledgeIds && !isEqual(session.knowledgeIds, knowledgeIds)) {
    await addFilesToProjects(user, { session, fileIds: knowledgeIds }, adapters);
  }

  session.name = name || session.name;
  session.knowledgeIds = knowledgeIds || session.knowledgeIds;
  session.artifactIds = artifactIds || session.artifactIds;
  session.tags = tags || session.tags;
  session.lastUsedModel = lastUsedModel || session.lastUsedModel;
  session.lastUpdated = new Date();

  await db.sessions.update(session);

  return session;
};

const addFilesToProjects = async (
  user: IUserDocument,
  params: {
    session: ISessionDocument;
    fileIds: string[];
  },
  adapters: UpdateSessionAdapters
) => {
  const { session, fileIds } = params;
  const { db, storage } = adapters;
  const projects = await db.projects.findAllBySessionId(session.id);

  const files = await db.fabFiles.findAllByIds(fileIds);

  // Hydrate the signed-URL cache for all files to speed up llm context retrieval.
  //
  // This pre-warm bypasses generateSignedUrl's moderation gate: it must not mint
  // (and cache, under `cachedSignedUrl:<filePath>`) a signed URL for a held/blocked uploaded
  // image. Skipping it here means the image simply has no pre-warmed cache entry, which is
  // correct since it must not be servable.
  await Promise.all(
    files.map(async file => {
      if (file.filePath && isImageServeable(file)) {
        try {
          await getCachedSignedUrl(file.filePath, storage, db);
        } catch (error) {
          // Log error but continue processing other files
          Logger.globalInstance.error(`Failed to cache signed URL for file ${file.id}:`, error);
        }
      }
    })
  );

  for (const project of projects) {
    project.fileIds = uniq([...project.fileIds, ...fileIds]);

    await updateShareableFiles(user.id, { project, files }, adapters);

    await db.projects.update(project);
  }
};
