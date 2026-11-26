import {
  GENERATION_JOB_ID_PATTERN,
  isGenerationJobOfKind,
  type GenerationJobKind,
  type IGenerationJobDocumentOf,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';

/**
 * Visibility is the requester, not the credit owner: org members never see each other's jobs. A malformed id,
 * a missing job, a job of another kind and someone else's job are indistinguishable (all null -> 404).
 */
export async function findOwnGenerationJob<K extends GenerationJobKind>(
  id: string,
  userId: string,
  kind: K,
  repository: Pick<IGenerationJobRepository, 'findById'> = generationJobRepository
): Promise<IGenerationJobDocumentOf<K> | null> {
  if (!GENERATION_JOB_ID_PATTERN.test(id)) return null;
  const job = await repository.findById(id);
  return job && isGenerationJobOfKind(job, kind) && job.requestedBy === userId ? job : null;
}
