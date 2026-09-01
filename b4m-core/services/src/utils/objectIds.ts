import { usableObjectIds } from '@bike4mind/db-core';
import { Logger } from '@bike4mind/observability';

/** The session id arrays that reference ObjectId-keyed collections. Excludes artifactIds. */
export type ObjectIdArrayKind = 'knowledge' | 'tool' | 'agent';

/**
 * Service-layer wrapper over db-core's `usableObjectIds`, kept so call sites name a session field
 * rather than a model. The reasoning for dropping rather than rejecting lives on the db-core
 * implementation; the part specific to here is that callers resubmit a STORED list - renaming a
 * notebook PUTs `{ ...session, name }` - so rejecting would block writes unrelated to knowledge.
 */
export const usableSessionIds = (
  ids: string[],
  kind: ObjectIdArrayKind,
  logger: Pick<typeof Logger.globalInstance, 'warn'> = Logger.globalInstance
): string[] => usableObjectIds(ids, kind, logger);

/**
 * Lowercased form used ONLY for comparing ids, never for storing them. A hex ObjectId is accepted
 * in either case and resolves the same row, but a resolved document's `id` is always canonical
 * lowercase - so comparing raw request strings rejects an uppercase id that Mongo handled fine.
 *
 * Do not write the result back to a document: a legacy non-hex entry like `Legacy-UUID-2019` would
 * be rewritten to a form that no longer matches what is stored.
 */
export const canonicalId = (id: string): string => id.toLowerCase();

/**
 * How many DISTINCT rows a request could address, ignoring hex case. Callers compare this against
 * the number of rows that resolved, so `[abc, ABC]` must count as one - it addresses one document.
 *
 * Exists as a helper because this comparison is repeated at six call sites and has been got wrong
 * twice: first counting raw duplicates, then counting case variants as separate ids.
 */
export const distinctIdCount = (ids: string[]): number => new Set(ids.map(canonicalId)).size;
