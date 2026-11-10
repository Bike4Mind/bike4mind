import { hashKey, type QueryClient } from '@tanstack/react-query';
import { settingsMap } from '@bike4mind/common';
import type { ModelCatalog } from '@client/app/utils/llm';
import { MODEL_CATALOG_QUERY_KEY } from '@client/app/hooks/data/useModelInfo';

/** Spreads the refetch one bump sets off across every connected tab. */
export const MODEL_LIST_REFETCH_JITTER_MS = 10_000;

interface RevisionWatch {
  /** The last revision the adminsettings subscription pushed. */
  pushed?: string;
  /** The pushed revision a refetch was already spent on; one per revision, so a lagging server cannot loop it. */
  refetchedFor?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const watches = new WeakMap<QueryClient, RevisionWatch>();

function watchOf(queryClient: QueryClient): RevisionWatch {
  let watch = watches.get(queryClient);
  if (!watch) {
    watch = {};
    watches.set(queryClient, watch);
  }
  return watch;
}

const listedRevision = (queryClient: QueryClient) =>
  queryClient.getQueryData<ModelCatalog>(MODEL_CATALOG_QUERY_KEY)?.modelListRevision;

/**
 * Refetch the model list when it was built under a revision other than the last one pushed (written by
 * packages/server-utils/src/modelDiscovery/modelListRevision.ts). Runs on every push and every time the
 * list lands, so a push that arrives during the first fetch still counts. The subscription replays the
 * row on every subscribe; a list that already matches it does nothing.
 */
function reconcile(queryClient: QueryClient, random: () => number): void {
  const watch = watchOf(queryClient);
  const { pushed } = watch;
  if (!pushed || watch.timer || watch.refetchedFor === pushed) return;
  const listed = listedRevision(queryClient);
  // undefined: no list yet; this runs again when it lands.
  if (listed === undefined || listed === pushed) return;
  watch.refetchedFor = pushed;
  watch.timer = setTimeout(() => {
    watch.timer = undefined;
    // Another path (a finished manual discovery run) may have refetched during the wait.
    if (listedRevision(queryClient) === watch.pushed) return;
    void queryClient.invalidateQueries({ queryKey: MODEL_CATALOG_QUERY_KEY });
  }, random() * MODEL_LIST_REFETCH_JITTER_MS);
}

export function handleModelListRevisionSetting(
  queryClient: QueryClient,
  setting: { settingName?: string; settingValue?: unknown },
  random: () => number = Math.random
): void {
  if (setting.settingName !== settingsMap.modelListRevision.key) return;
  const revision = setting.settingValue;
  if (typeof revision !== 'string' || revision.length === 0) return;
  watchOf(queryClient).pushed = revision;
  reconcile(queryClient, random);
}

/** Re-checks the pushed revision each time the model list lands. Returns the unsubscribe. */
export function watchModelListArrivals(queryClient: QueryClient, random: () => number = Math.random): () => void {
  const catalogHash = hashKey(MODEL_CATALOG_QUERY_KEY);
  return queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (event.query.queryHash !== catalogHash) return;
    reconcile(queryClient, random);
  });
}
