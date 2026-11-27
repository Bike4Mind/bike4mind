import {
  NotFoundError,
  STUDIO_COMPOSITION_LIMITS,
  UnprocessableEntityError,
  defaultStudioShots,
  defaultStudioTimeline,
  studioCompositionFileIds,
  studioFileMediaKind,
  validateStudioComposition,
  type IStudioCompositionDocument,
  type IStudioCompositionSummary,
  type StudioCompositionContent,
  type StudioCompositionCreateInput,
  type StudioCompositionReferences,
  type StudioCompositionUpdateInput,
} from '@bike4mind/common';
import type { StudioCompositionServiceAdapters } from './ports';

/**
 * Studio composition (Production) operations. Owner-only: every call is bound to the server-resolved `userId`
 * and a composition owned by anyone else answers exactly like a missing one (404). Inputs arrive already parsed
 * by the Create/Update input schemas; this layer adds the checks that need storage, namely referenced files the
 * caller can read and a project the caller owns.
 */

const NOT_FOUND_MESSAGE = 'Composition not found';

// A key present as `undefined` in `$set` would null the stored field instead of leaving it alone.
const omitUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

const assertProjectOwned = async (
  { db }: StudioCompositionServiceAdapters,
  userId: string,
  projectId: string | undefined
): Promise<void> => {
  if (!projectId) return;
  const project = await db.projects.findByIdAndUserId(projectId, userId);
  if (!project) throw new UnprocessableEntityError('Project not found', { field: 'projectId' });
};

/**
 * Access is required only for newly referenced files: a file already on the stored composition stays valid even if
 * since deleted or unshared. The kind a slot plays is checked for every referenced file the caller can still read.
 */
const assertContentValid = async (
  { db }: StudioCompositionServiceAdapters,
  userId: string,
  content: StudioCompositionReferences,
  previouslyReferenced: ReadonlySet<string>
): Promise<void> => {
  const fileIds = [...new Set(studioCompositionFileIds(content))];
  const accessible = fileIds.length > 0 ? await db.fabFiles.findAccessibleInIds(fileIds, { userId }) : [];
  const knownFileIds = new Set([...previouslyReferenced, ...accessible.map(file => file.id)]);
  const fileKinds = new Map(accessible.map(file => [file.id, studioFileMediaKind(file.mimeType)]));

  const issues = validateStudioComposition(content, { knownFileIds, fileKinds });
  if (issues.length > 0) throw new UnprocessableEntityError('Invalid composition', { issues });
};

export async function createComposition(
  userId: string,
  adapters: StudioCompositionServiceAdapters,
  input: StudioCompositionCreateInput
): Promise<IStudioCompositionDocument> {
  const content: StudioCompositionContent = {
    ...input,
    shots: input.shots ?? defaultStudioShots(input.template),
    timeline: input.timeline ?? defaultStudioTimeline(input.template),
  };
  await assertProjectOwned(adapters, userId, content.projectId);
  await assertContentValid(adapters, userId, content, new Set());
  return adapters.db.compositions.createOwned({ ...content, userId });
}

export async function getComposition(
  userId: string,
  { db }: StudioCompositionServiceAdapters,
  id: string
): Promise<IStudioCompositionDocument> {
  const composition = await db.compositions.findOwned(id, userId);
  if (!composition) throw new NotFoundError(NOT_FOUND_MESSAGE);
  return composition;
}

export async function listCompositions(
  userId: string,
  { db }: StudioCompositionServiceAdapters,
  page: { limit: number; skip: number }
): Promise<IStudioCompositionSummary[]> {
  const limit = Math.min(Math.max(page.limit, 1), STUDIO_COMPOSITION_LIMITS.listLimitMax);
  return db.compositions.listOwned(userId, { limit, skip: Math.max(page.skip, 0) });
}

/** Each field in the patch replaces the stored one whole; `projectId: null` unlinks the project. */
export async function updateComposition(
  userId: string,
  adapters: StudioCompositionServiceAdapters,
  id: string,
  input: StudioCompositionUpdateInput
): Promise<IStudioCompositionDocument> {
  const existing = await getComposition(userId, adapters, id);
  const { projectId, ...fields } = input;
  const patch = omitUndefined<Partial<StudioCompositionContent>>({ ...fields, ...(projectId && { projectId }) });

  if (patch.projectId && patch.projectId !== existing.projectId) {
    await assertProjectOwned(adapters, userId, patch.projectId);
  }
  if (patch.brief || patch.brandKit || patch.shots || patch.timeline) {
    const merged = {
      brief: patch.brief ?? existing.brief,
      brandKit: patch.brandKit ?? existing.brandKit,
      shots: patch.shots ?? existing.shots,
      timeline: patch.timeline ?? existing.timeline,
    };
    await assertContentValid(adapters, userId, merged, new Set(studioCompositionFileIds(existing)));
  }

  const updated = await adapters.db.compositions.updateOwned(
    id,
    userId,
    patch,
    projectId === null ? ['projectId'] : []
  );
  if (!updated) throw new NotFoundError(NOT_FOUND_MESSAGE);
  return updated;
}

export async function deleteComposition(
  userId: string,
  { db }: StudioCompositionServiceAdapters,
  id: string
): Promise<void> {
  const deleted = await db.compositions.deleteOwned(id, userId);
  if (!deleted) throw new NotFoundError(NOT_FOUND_MESSAGE);
}
