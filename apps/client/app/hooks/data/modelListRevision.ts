import type { QueryClient } from '@tanstack/react-query';
import { settingsMap } from '@bike4mind/common';
import type { ModelCatalog } from '@client/app/utils/llm';
import { MODEL_CATALOG_QUERY_KEY } from '@client/app/hooks/data/useModelInfo';

/** Spreads the refetch one bump sets off across every connected tab. */
export const MODEL_LIST_REFETCH_JITTER_MS = 5_000;

const cachedRevision = (queryClient: QueryClient) =>
  queryClient.getQueryData<ModelCatalog>(MODEL_CATALOG_QUERY_KEY)?.modelListRevision;

/**
 * Refetch the model list when the adminsettings subscription pushes a model-list revision it was not
 * built under (written by packages/server-utils/src/modelDiscovery/modelListRevision.ts). The
 * subscription replays the row on every subscribe, so a page load or a reconnect matches and does nothing.
 */
export function handleModelListRevisionSetting(
  queryClient: QueryClient,
  setting: { settingName?: string; settingValue?: unknown },
  random: () => number = Math.random
): void {
  if (setting.settingName !== settingsMap.modelListRevision.key) return;
  const revision = setting.settingValue;
  if (typeof revision !== 'string' || revision.length === 0) return;
  const current = cachedRevision(queryClient);
  // undefined: no list fetched yet, and the first fetch reads the current revision itself.
  if (current === undefined || current === revision) return;
  setTimeout(() => {
    // Another path (a finished manual discovery run) may have refetched during the wait.
    if (cachedRevision(queryClient) === revision) return;
    void queryClient.invalidateQueries({ queryKey: MODEL_CATALOG_QUERY_KEY });
  }, random() * MODEL_LIST_REFETCH_JITTER_MS);
}
