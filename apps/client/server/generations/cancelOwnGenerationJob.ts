import type { IGenerationJobDocument } from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';
import { getGenerationJobEngine } from '@server/generationJobs/wiring';

/**
 * Requests cancellation of a job the caller owns (resolve it with findOwnGenerationJob first) and returns its
 * current state. A job already storing or terminal cannot be cancelled: the provider has produced (and charged
 * for) the output, so it is reported as is.
 */
export async function cancelOwnGenerationJob(job: IGenerationJobDocument): Promise<IGenerationJobDocument> {
  const requested = await getGenerationJobEngine().requestCancel(job.id);
  return requested ?? (await generationJobRepository.findById(job.id)) ?? job;
}
