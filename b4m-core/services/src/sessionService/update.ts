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
  SessionUpdateRequestSchema,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { secureParameters } from '@bike4mind/utils';
import { BaseStorage, getCachedSignedUrl } from '@bike4mind/utils';
import uniq from 'lodash/uniq.js';
import isEqual from 'lodash/isEqual.js';
import { z } from 'zod';

// `id` is service-internal addressing, not a field the public PUT request body carries
// (it comes from the URL path there) - extend rather than fold it into the shared schema.
const updateSessionParamtersSchema = SessionUpdateRequestSchema.extend({
  id: z.string(),
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
  const { knowledgeIds, artifactIds, name, id, tags, lastUsedModel, forceKnowledgeRetrieval, propagateToProjects } =
    secureParameters(parameters, updateSessionParamtersSchema);
  const session = await db.sessions.shareable.findUpdateAccessById(user, id);

  if (!session) {
    throw new NotFoundError('Session not found');
  }

  // Propagate only what this write ADDS, never the whole list.
  //
  // Propagating the full list makes the propagateToProjects flag leak across writes: a
  // file added earlier with propagation off gets pushed into the project by the next
  // write that happens to have it on, and a removal - which sends the surviving files -
  // propagates all of them. Since project.fileIds is append-only and additive, the
  // delta is the only set that ever needs propagating anyway.
  if (knowledgeIds && !isEqual(session.knowledgeIds, knowledgeIds) && propagateToProjects !== false) {
    const alreadyKnown = new Set(session.knowledgeIds ?? []);
    const addedFileIds = knowledgeIds.filter(id => !alreadyKnown.has(id));
    if (addedFileIds.length > 0) {
      await addFilesToProjects(user, { session, fileIds: addedFileIds }, adapters);
    }
  }

  session.name = name || session.name;
  session.knowledgeIds = knowledgeIds || session.knowledgeIds;
  session.artifactIds = artifactIds || session.artifactIds;
  session.tags = tags || session.tags;
  session.lastUsedModel = lastUsedModel || session.lastUsedModel;
  // Explicit undefined check (not `|| session.x`) so toggling OFF (false) actually persists.
  if (forceKnowledgeRetrieval !== undefined) {
    session.forceKnowledgeRetrieval = forceKnowledgeRetrieval;
  }
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
  const { session } = params;
  let { fileIds } = params;
  const { db, storage } = adapters;
  const projects = await db.projects.findAllBySessionId(session.id);

  // Access-check before granting. findAllByIds has no ACL, and updateShareableFiles
  // below grants every project member read+update on whatever it is handed - so an
  // unchecked id here lets a caller PUT someone else's fileId into their own session
  // and share it with their project. The sibling path (projectService/addFiles) has
  // always resolved through `shareable`; this one did not.
  //
  // Filters rather than throwing, unlike that sibling: a session's knowledgeIds can
  // legitimately contain a global/system file that the shareable filter does not return
  // for this user, and failing the whole session write on one such id would be a
  // regression. Skipping it grants nothing, which is the property that matters.
  const files = await db.fabFiles.shareable.findAllAccessibleByIds(user, fileIds);
  if (files.length !== fileIds.length) {
    const accessible = new Set(files.map(f => f.id));
    const refused = fileIds.filter(id => !accessible.has(id));
    Logger.globalInstance.warn(
      `addFilesToProjects: refusing to share ${refused.length} file(s) not accessible to user ${user.id}: ` +
        `${refused.join(', ')}`
    );
    fileIds = fileIds.filter(id => accessible.has(id));
    if (fileIds.length === 0) return;
  }

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
