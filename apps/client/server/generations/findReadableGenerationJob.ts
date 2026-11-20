import {
  GENERATION_JOB_ID_PATTERN,
  isGenerationJobOfKind,
  type GenerationJobKind,
  type IChatHistoryItemRepository,
  type IGenerationJobDocumentOf,
  type IGenerationJobRepository,
  type ISessionDocument,
  type IShareableStaticMethods,
  type IUserDocument,
} from '@bike4mind/common';
import { generationJobRepository, questRepository, sessionRepository } from '@bike4mind/database';

export type FindReadableGenerationJobDeps = {
  jobs: Pick<IGenerationJobRepository, 'findById'>;
  quests: Pick<IChatHistoryItemRepository, 'findById'>;
  sessions: Pick<IShareableStaticMethods<ISessionDocument>, 'findAccessibleById'>;
};

const defaultDeps = (): FindReadableGenerationJobDeps => ({
  jobs: generationJobRepository,
  quests: questRepository,
  sessions: sessionRepository.shareable,
});

/**
 * A job its requester can read, or one made in a notebook turn the caller can read: read access follows the
 * session as for the rest of the chat (sessions/[id]/generated-media.ts), so a sharee sees the same cards as the
 * owner. Anything else is null (-> 404), indistinguishable from a missing job. Unlike findOwnGenerationJob, this is
 * for reads only: cancelling stays the requester's.
 */
export async function findReadableGenerationJob<K extends GenerationJobKind>(
  id: string,
  user: IUserDocument,
  kind: K,
  deps: FindReadableGenerationJobDeps = defaultDeps()
): Promise<IGenerationJobDocumentOf<K> | null> {
  if (!GENERATION_JOB_ID_PATTERN.test(id)) return null;
  const job = await deps.jobs.findById(id);
  if (!job || !isGenerationJobOfKind(job, kind)) return null;
  if (job.requestedBy === user.id) return job;
  if (!job.questId) return null;
  const quest = await deps.quests.findById(job.questId);
  if (!quest?.sessionId) return null;
  const session = await deps.sessions.findAccessibleById(user, String(quest.sessionId));
  return session ? job : null;
}
