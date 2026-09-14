import { Logger } from '@bike4mind/observability';
import { pushShareable } from '../sharingService';
import { IFabFileRepository, IProjectDocument, IProjectRepository, IUserDocument, Permission } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { canonicalId, distinctIdCount } from '../utils/objectIds';
import uniq from 'lodash/uniq.js';

const addSystemPromptsSchema = z.object({
  projectId: z.string(),
  fileIds: z.array(z.string()),
});

type AddSystemPromptsParameters = z.infer<typeof addSystemPromptsSchema>;

interface AddSystemPromptsAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const addSystemPrompts = async (
  user: IUserDocument,
  params: AddSystemPromptsParameters,
  adapters: AddSystemPromptsAdapters
) => {
  const { db } = adapters;
  const { projectId, fileIds } = secureParameters(params, addSystemPromptsSchema);

  // Update-level, not read-level: adding a system prompt mutates the project and pushes share
  // grants onto the attached files, so a read grant must not reach it. Normalized to a plain
  // object because this predicate returns a hydrated document where findAccessibleById did not,
  // and `project` is handed to db.projects.update below.
  const found = await db.projects.shareable.findUpdateAccessById(user, projectId);
  // NotFoundError, not a bare Error: this refusal is routine and user-triggerable - a read-only
  // sharee clicking the button reaches it - and a bare Error is a 500 that pages LiveOps. 404
  // rather than 403 for the same reason every other door in this service answers 404: it does not
  // tell a caller whether a project they cannot reach exists.
  if (!found) throw new NotFoundError('Project not found');

  const project = (
    typeof (found as { toJSON?: unknown }).toJSON === 'function'
      ? (found as unknown as { toJSON: () => IProjectDocument }).toJSON()
      : found
  ) as IProjectDocument;

  const files = await db.fabFiles.shareable.findAllAccessibleByIds(user, fileIds);
  if (files.length !== distinctIdCount(fileIds)) throw new BadRequestError('Some files are not accessible');

  // Resolved ids, in REQUEST order: a doubled id - or the same id in two hex cases - would push two
  // systemPrompts entries for one file, but `files` comes back in Mongo's order, and this array's
  // order is the order the prompts compose in (ChatCompletionFeatures).
  const resolvedById = new Map(files.map(f => [canonicalId(f.id), f.id]));
  const resolvedIds = uniq(fileIds.map(id => resolvedById.get(canonicalId(id))).filter((id): id is string => !!id));
  // Canonical on both sides: a legacy systemPrompts row stored with an uppercase hex fileId names
  // the same file, and comparing raw would add a second prompt for it.
  const existingPromptIds = new Set(project.systemPrompts.map(prompt => canonicalId(prompt.fileId)));
  const newFileIds = resolvedIds.filter(fileId => !existingPromptIds.has(canonicalId(fileId)));

  if (newFileIds.length === 0) {
    throw new BadRequestError('All files are already added as system prompts');
  }

  const newSystemPrompts = newFileIds.map(fileId => ({
    fileId,
    enabled: true,
  }));

  project.systemPrompts.push(...newSystemPrompts);
  project.updatedAt = new Date();

  try {
    const fileUpdates = [];
    for (const file of files) {
      // Share with project owner if they're not the one adding the file
      if (project.userId !== user.id) {
        pushShareable(file, {
          userId: project.userId,
          permissions: [Permission.read, Permission.update],
          projectId,
        });
      }

      // Share with all project members
      for (const projectUser of project.users) {
        pushShareable(file, { userId: projectUser.userId, permissions: projectUser.permissions, projectId });
      }

      fileUpdates.push(db.fabFiles.update(file));
    }

    await Promise.all([...fileUpdates, db.projects.update(project)]);

    return project;
  } catch (error) {
    // Cleanup on error - remove added system prompts
    project.systemPrompts = project.systemPrompts.filter(prompt => !newFileIds.includes(prompt.fileId));

    try {
      // Write only the fields this cleanup path touches, not the whole stale project: the success
      // path above may have already advanced the doc, and a whole-doc write would clobber it.
      await db.projects.update({ id: project.id, systemPrompts: project.systemPrompts });
    } catch (cleanupError) {
      Logger.globalInstance.error('Failed to cleanup after error:', cleanupError);
    }

    throw error;
  }
};
