import {
  GENERATION_JOB_ID_PATTERN,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';

/**
 * Visibility is the requester, not the credit owner: org members never see each other's jobs. A malformed id,
 * a missing job, a non-video job and someone else's job are indistinguishable (all null -> 404).
 */
export async function findOwnVideoJob(
  id: string,
  userId: string,
  repository: Pick<IGenerationJobRepository, 'findById'> = generationJobRepository
): Promise<IGenerationJobDocument | null> {
  if (!GENERATION_JOB_ID_PATTERN.test(id)) return null;
  const job = await repository.findById(id);
  return job && job.kind === 'video' && job.requestedBy === userId ? job : null;
}
