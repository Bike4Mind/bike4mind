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
