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
 *
 * Only hex is folded. Mongo treats hex case-insensitively, arbitrary strings it does not, and these
 * arrays are declared `[{ type: String }]` precisely so they can hold a non-hex legacy id. Folding
 * those too would make an imported `Doc-A` and `doc-a` compare equal, so removing one drops both.
 */
const HEX_OBJECT_ID = /^[0-9a-f]{24}$/i;

export const canonicalId = (id: string): string => (HEX_OBJECT_ID.test(id) ? id.toLowerCase() : id);

/**
 * How many DISTINCT rows a request could address, ignoring hex case. Callers compare this against
 * the number of rows that resolved, so `[abc, ABC]` must count as one - it addresses one document.
 *
 * Exists as a helper because this comparison is repeated at six call sites and has been got wrong
 * twice: first counting raw duplicates, then counting case variants as separate ids.
 */
export const distinctIdCount = (ids: string[]): number => new Set(ids.map(canonicalId)).size;

/**
 * Appends `incoming` to `existing`, skipping any id already present ignoring hex case.
 *
 * `uniq` alone is case-sensitive, so a row written before ids were canonicalised can hold `ABC`
 * and still gain a second `abc` entry for the same file - and the reader's own `uniq`
 * (ChatCompletionFeatures) is case-sensitive too, so that file gets fetched and embedded into the
 * prompt twice. Stored entries are returned untouched: rewriting one to its canonical form would
 * break a non-hex legacy id, per canonicalId above.
 */
export const mergeIds = (existing: string[], incoming: string[]): string[] => {
  const seen = new Set(existing.map(canonicalId));
  const merged = [...existing];
  for (const id of incoming) {
    const key = canonicalId(id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(id);
  }
  return merged;
};
