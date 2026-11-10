import { useQuery } from '@tanstack/react-query';
import type { AdminModelListResponse, AdminModelRow } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ADMIN_MODELS_QUERY_KEY, adminModelListParams } from '@client/app/hooks/data/adminModels';

/** The server's page size cap (ADMIN_MODEL_PAGE_SIZE_MAX in the discovery service). */
const PAGE_SIZE = 500;
const MAX_PAGES = 10;

/**
 * Every model the admin list knows, by id: the names, statuses and reasons the discovery pages show beside ids.
 * Under ADMIN_MODELS_QUERY_KEY, so a write that refreshes the list refreshes this too. An id it lacks (a model
 * only a report-mode run saw) has no catalog row.
 */
export const useModelIndex = () =>
  useQuery({
    queryKey: [...ADMIN_MODELS_QUERY_KEY, 'index'],
    queryFn: async (): Promise<Map<string, AdminModelRow>> => {
      const index = new Map<string, AdminModelRow>();
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const params = adminModelListParams({
          filter: { view: 'all', showFoundationIds: true },
          sort: 'name',
          page,
          pageSize: PAGE_SIZE,
        });
        const response = (await api.get<AdminModelListResponse>('/api/admin/models', { params })).data;
        for (const model of response.models) index.set(model.id, model);
        if (page * PAGE_SIZE >= response.total || response.models.length === 0) break;
      }
      return index;
    },
    staleTime: 30_000,
  });

/** The model's name when the index knows it, else its id. */
export const modelName = (index: ReadonlyMap<string, AdminModelRow> | undefined, id: string): string =>
  index?.get(id)?.name || id;
