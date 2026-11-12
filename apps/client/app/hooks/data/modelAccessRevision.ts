import { hashKey, type QueryClient } from '@tanstack/react-query';
import type { ModelConfigurationsRead } from './modelAccessDraft';

export const MODEL_CONFIGURATIONS_QUERY_KEY = ['llm-model-configurations'] as const;
type RevisionWatch = { pushed?: string; refetchedFor?: string };
const watches = new WeakMap<QueryClient, RevisionWatch>();
const watchOf = (client: QueryClient) => {
  const existing = watches.get(client);
  if (existing) return existing;
  const watch: RevisionWatch = {};
  watches.set(client, watch);
  return watch;
};

function reconcile(client: QueryClient): void {
  const watch = watchOf(client);
  const target = watch.pushed;
  if (!target || watch.refetchedFor === target) return;
  const read = client.getQueryData<ModelConfigurationsRead>(MODEL_CONFIGURATIONS_QUERY_KEY);
  // A push during the first fetch is checked again when its response lands.
  if (!read || client.getQueryState(MODEL_CONFIGURATIONS_QUERY_KEY)?.fetchStatus === 'fetching') return;
  if (read.revision === target) return;
  watch.refetchedFor = target;
  // This query has no server-side list memo to wait out. Refetch cached inactive pickers as well.
  void client
    .invalidateQueries({ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY, refetchType: 'all' }, { throwOnError: true })
    .catch(() => {
      // A later push/arrival may retry the same revision after an explicit failed refresh.
      if (watch.refetchedFor === target) watch.refetchedFor = undefined;
    });
}

export function handleModelAccessRevisionSetting(
  client: QueryClient,
  setting: { settingName?: string; settingValue?: unknown }
): void {
  if (
    setting.settingName !== 'modelAccessRevision' ||
    typeof setting.settingValue !== 'string' ||
    !setting.settingValue
  )
    return;
  watchOf(client).pushed = setting.settingValue;
  reconcile(client);
}

export function watchModelAccessArrivals(client: QueryClient): () => void {
  const hash = hashKey(MODEL_CONFIGURATIONS_QUERY_KEY);
  return client.getQueryCache().subscribe(event => {
    if (event.type === 'updated' && event.action.type === 'success' && event.query.queryHash === hash)
      reconcile(client);
  });
}
