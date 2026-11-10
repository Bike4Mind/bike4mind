import type { ICacheDocument } from './types/entities/CacheTypes';

/**
 * Cache row holding the shared model-list revision. Written by bumpModelListRevision
 * (packages/server-utils/src/modelDiscovery/modelListRevision.ts); outside `model-list:*` on purpose,
 * since apps/client/server/utils/callerModelList.ts is the only writer of those keys.
 */
export const MODEL_LIST_REVISION_CACHE_KEY = 'model-list-revision';

export function modelListRevisionOf(doc: Pick<ICacheDocument, 'result'> | null | undefined): string | null {
  const revision = (doc?.result as { revision?: unknown } | undefined)?.revision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}
