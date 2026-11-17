import { useQuery } from '@tanstack/react-query';
import type { AdminModelRow } from '@bike4mind/common';
import { ADMIN_MODELS_QUERY_KEY, fetchAllAdminModels } from '@client/app/hooks/data/adminModels';

/**
 * Every model the admin list knows, by id: the names, statuses and reasons the discovery pages show beside ids.
 * Under ADMIN_MODELS_QUERY_KEY, so a write that refreshes the list refreshes this too. An id it lacks (a model
 * only a report-mode run saw) has no catalog row, unless `truncated`: the lookup stopped at its page cap.
 */
export const useModelIndex = () =>
  useQuery({
    queryKey: [...ADMIN_MODELS_QUERY_KEY, 'index'],
    queryFn: async (): Promise<{ byId: Map<string, AdminModelRow>; truncated: boolean }> => {
      const { rows, truncated } = await fetchAllAdminModels({
        filter: { view: 'all', showFoundationIds: true },
        sort: 'name',
      });
      return { byId: new Map(rows.map(model => [model.id, model])), truncated };
    },
    staleTime: 30_000,
  });

/** The model's name when the index knows it, else its id. */
export const modelName = (index: ReadonlyMap<string, AdminModelRow> | undefined, id: string): string =>
  index?.get(id)?.name || id;
