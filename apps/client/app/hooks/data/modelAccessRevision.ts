import { hashKey, type QueryClient } from '@tanstack/react-query';
import { settingsMap } from '@bike4mind/common';
import { LLM_MODEL_CONFIGURATIONS_QUERY_KEY, type LLMModelConfigurationsData } from './llmModelConfig';

/**
 * Spreads the refetch one access write sets off across every connected tab. No server process caches access
 * entries, so unlike the model-list revision (./modelListRevision.ts) there is no memo to wait out.
 */
export const MODEL_ACCESS_REFETCH_JITTER_MS = 10_000;

interface RevisionWatch {
  /** The last revision the adminsettings subscription pushed. */
  pushed?: string;
  /** The pushed revision a refetch already landed for; one per revision, so a lagging read cannot loop it. */
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

/** undefined: no entries read yet; null: read before the first access write ever bumped the revision. */
const readRevision = (queryClient: QueryClient) =>
  queryClient.getQueryData<LLMModelConfigurationsData>(LLM_MODEL_CONFIGURATIONS_QUERY_KEY)?.revision;

/**
 * Refetch the access entries when they were read under a revision other than the last one pushed (written by
 * packages/server-utils/src/modelDiscovery/modelAccessRevision.ts, echoed by GET
 * /api/admin/llm-models/configurations in MODEL_ACCESS_REVISION_HEADER). Runs on every push and every time the
 * entries land, so a push that arrives during the first fetch still counts. The subscription replays the row on
 * every subscribe; entries that already match it do nothing.
 */
function reconcile(queryClient: QueryClient, random: () => number): void {
  const watch = watchOf(queryClient);
  const { pushed } = watch;
  if (!pushed || watch.timer || watch.refetchedFor === pushed) return;
  const read = readRevision(queryClient);
  if (read === undefined || read === pushed) return;
  watch.timer = setTimeout(() => {
    watch.timer = undefined;
    // Another path (this tab's own write, an admission refusal) may have refetched during the wait.
    const target = watch.pushed;
    if (!target || readRevision(queryClient) === target) return;
    watch.refetchedFor = target;
    void queryClient.invalidateQueries({ queryKey: LLM_MODEL_CONFIGURATIONS_QUERY_KEY }).then(() => {
      // A failed refetch has not used up the revision: the next push or landing tries again.
      if (queryClient.getQueryState(LLM_MODEL_CONFIGURATIONS_QUERY_KEY)?.status === 'error') {
        watch.refetchedFor = undefined;
      }
    });
  }, random() * MODEL_ACCESS_REFETCH_JITTER_MS);
}

export function handleModelAccessRevisionSetting(
  queryClient: QueryClient,
  setting: { settingName?: string; settingValue?: unknown },
  random: () => number = Math.random
): void {
  if (setting.settingName !== settingsMap.modelAccessRevision.key) return;
  const revision = setting.settingValue;
  if (typeof revision !== 'string' || revision.length === 0) return;
  watchOf(queryClient).pushed = revision;
  reconcile(queryClient, random);
}

/** Re-checks the pushed revision each time the access entries land. Returns the unsubscribe. */
export function watchModelAccessArrivals(queryClient: QueryClient, random: () => number = Math.random): () => void {
  const entriesHash = hashKey(LLM_MODEL_CONFIGURATIONS_QUERY_KEY);
  return queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (event.query.queryHash !== entriesHash) return;
    reconcile(queryClient, random);
  });
}
