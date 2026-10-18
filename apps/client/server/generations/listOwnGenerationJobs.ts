import {
  GENERATION_JOB_ID_PATTERN,
  isGenerationJobOfKind,
  UnprocessableEntityError,
  type GenerationJobKind,
  type GenerationJobSource,
  type GenerationJobState,
  type IGenerationJobDocumentOf,
} from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';

export type ListOwnGenerationJobsQuery<K extends GenerationJobKind = GenerationJobKind> = {
  userId: string;
  kind: K;
  /** Per route, so a cursor from one list endpoint is rejected by another. */
  cursorScope: string;
  limit: number;
  cursor?: string;
  state?: GenerationJobState;
  source?: GenerationJobSource;
};

export type GenerationJobsPage<K extends GenerationJobKind = GenerationJobKind> = {
  jobs: IGenerationJobDocumentOf<K>[];
  nextCursor: string | null;
};

/** One page of the caller's own jobs of one kind, newest first. Throws 422 on a malformed cursor. */
export async function listOwnGenerationJobs<K extends GenerationJobKind>(
  query: ListOwnGenerationJobsQuery<K>
): Promise<GenerationJobsPage<K>> {
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
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(cursorScope, page[page.length - 1].id) : null;
  // The query already filters by kind; this narrows the type.
  const jobs = page.flatMap(job => (isGenerationJobOfKind(job, kind) ? [job] : []));
  return { jobs, nextCursor };
}
