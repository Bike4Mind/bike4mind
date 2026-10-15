import type { ApiErrorCode, IGenerationJobDocument } from '@bike4mind/common';
import { getGenerationJobEngine } from '@server/generationJobs/wiring';
import { ConflictError } from '@server/utils/errors';

/**
 * Requests cancellation of a job the caller owns (resolve it with findOwnGenerationJob first) and returns its
 * current state. A job already storing or terminal cannot be cancelled: the provider has produced (and charged
 * for) the output, so it is reported as is. A sync job (music) whose provider call has started is refused with a
 * 409: the provider bills once the call starts, so reporting it as cancellable would promise a refund that may
 * never come.
 */
export async function cancelOwnGenerationJob<T extends IGenerationJobDocument>(job: T): Promise<T> {
  const outcome = await getGenerationJobEngine().requestCancel(job);
  if (outcome.status === 'not_cancellable') {
    throw new ConflictError('The generation is already in progress at the provider and can no longer be cancelled', {
      errorCode: 'not_cancellable' satisfies ApiErrorCode,
    });
  }
  return outcome.job && isSameKind(outcome.job, job) ? outcome.job : job;
}

// A job never changes kind; this only carries the caller's narrowed type over to the re-read document.
const isSameKind = <T extends IGenerationJobDocument>(candidate: IGenerationJobDocument, like: T): candidate is T =>
  candidate.kind === like.kind;
