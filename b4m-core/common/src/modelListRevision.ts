import type { ICacheDocument } from './types/entities/CacheTypes';

/**
 * Cache row holding the shared model-list revision. Written by bumpModelListRevision
 * (packages/server-utils/src/modelDiscovery/modelListRevision.ts); outside `model-list:*` on purpose,
 * since apps/client/server/utils/callerModelList.ts is the only writer of those keys.
 */
export const MODEL_LIST_REVISION_CACHE_KEY = 'model-list-revision';

/**
 * How long a server process may keep serving a list built under the previous revision (getAvailableModels'
 * revision memo in b4m-core/llm-adapters). A tab waits at least this long after a push before refetching,
 * so a model it shows is one chat already accepts.
 */
export const MODEL_LIST_REVISION_MEMO_MS = 5_000;

export function modelListRevisionOf(doc: Pick<ICacheDocument, 'result'> | null | undefined): string | null {
  const revision = (doc?.result as { revision?: unknown } | undefined)?.revision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}
