import type { IGenerationJobDocument } from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';
import { getGenerationJobEngine } from '@server/generationJobs/wiring';

/**
 * Requests cancellation of a job the caller owns (resolve it with findOwnGenerationJob first) and returns its
 * current state. A job already storing or terminal cannot be cancelled: the provider has produced (and charged
 * for) the output, so it is reported as is.
 */
export async function cancelOwnGenerationJob<T extends IGenerationJobDocument>(job: T): Promise<T> {
  const current =
    (await getGenerationJobEngine().requestCancel(job.id)) ?? (await generationJobRepository.findById(job.id));
  return current && isSameKind(current, job) ? current : job;
}

// A job never changes kind; this only carries the caller's narrowed type over to the re-read document.
const isSameKind = <T extends IGenerationJobDocument>(candidate: IGenerationJobDocument, like: T): candidate is T =>
  candidate.kind === like.kind;
