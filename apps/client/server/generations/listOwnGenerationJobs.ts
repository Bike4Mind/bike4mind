import {
  GENERATION_JOB_ID_PATTERN,
  UnprocessableEntityError,
  type GenerationJobKind,
  type GenerationJobSource,
  type GenerationJobState,
  type IGenerationJobDocument,
} from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';

export type ListOwnGenerationJobsQuery = {
  userId: string;
  kind: GenerationJobKind;
  /** Per route, so a cursor from one list endpoint is rejected by another. */
  cursorScope: string;
  limit: number;
  cursor?: string;
  state?: GenerationJobState;
  source?: GenerationJobSource;
};

export type GenerationJobsPage = { jobs: IGenerationJobDocument[]; nextCursor: string | null };

/** One page of the caller's own jobs of one kind, newest first. Throws 422 on a malformed cursor. */
export async function listOwnGenerationJobs(query: ListOwnGenerationJobsQuery): Promise<GenerationJobsPage> {
  const { userId, kind, cursorScope, limit, cursor, state, source } = query;
  const beforeId = cursor === undefined ? undefined : decodeCursor(cursor, cursorScope);
  // A decoded id is client-controlled; keep a malformed one away from Mongo (it would be a BSON 500).
  if (beforeId !== undefined && !GENERATION_JOB_ID_PATTERN.test(beforeId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }
  // One extra row tells whether another page exists without a count query.
  const rows = await generationJobRepository.listByRequester({
    requestedBy: userId,
    kind,
    state,
    source,
    beforeId,
    limit: limit + 1,
  });
  const jobs = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(cursorScope, jobs[jobs.length - 1].id) : null;
  return { jobs, nextCursor };
}
