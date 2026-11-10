import { useMemo } from 'react';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type {
  AdminModelFilter,
  AdminModelListResponse,
  AdminModelRow,
  AdminModelSort,
  AuditEntry,
  AuditLogPage,
  ModelAccessBulkDryRun,
  ModelAccessBulkRequestInput,
  ModelAccessBulkResult,
  ModelAccessEntry,
  ModelAccessPatchRequest,
  ModelAccessPatchResult,
  ModelUserTagCount,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { LLM_MODEL_CONFIGURATIONS_QUERY_KEY, useLLMModelConfigurations } from './llmModelConfig';
import { reviveAuditEntry, type WireAuditEntry } from './adminAuditLog';

/**
 * The admin model console's reads and writes (apps/client/pages/api/admin/models/*). Wire types live in
 * @bike4mind/common (schemas/adminModels.ts, modelAccess.ts).
 */

/** Every admin model query sits under this key, so one invalidation refreshes the list, a detail and the counts. */
export const ADMIN_MODELS_QUERY_KEY = ['admin', 'models'] as const;

export type AdminModelListQuery = {
  /** Always explicit: the server defaults to `all`, and a missing view in a bulk `{ filter }` selects every model. */
  filter: AdminModelFilter & { view: NonNullable<AdminModelFilter['view']> };
  sort?: AdminModelSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

/** The list query string the server reads: lists comma-joined, booleans as strings. */
export const adminModelListParams = ({ filter, sort, dir, page, pageSize }: AdminModelListQuery) => {
  const params: Record<string, string> = { view: filter.view };
  if (filter.search) params.search = filter.search;
  if (filter.providers?.length) params.providers = filter.providers.join(',');
  if (filter.types?.length) params.types = filter.types.join(',');
  if (filter.sources?.length) params.sources = filter.sources.join(',');
  if (filter.showFoundationIds) params.showFoundationIds = 'true';
  if (sort) params.sort = sort;
  if (dir) params.dir = dir;
  if (page) params.page = String(page);
  if (pageSize) params.pageSize = String(pageSize);
  return params;
};

const fetchAdminModels = async (query: AdminModelListQuery): Promise<AdminModelListResponse> =>
  (await api.get<AdminModelListResponse>('/api/admin/models', { params: adminModelListParams(query) })).data;

export const useAdminModelList = (query: AdminModelListQuery, options: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: [...ADMIN_MODELS_QUERY_KEY, 'list', adminModelListParams(query)],
    queryFn: () => fetchAdminModels(query),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });

/** The server's search filter accepts 200 characters; a prefix of a longer id still matches it. */
const SEARCH_MAX = 200;
const LOOKUP_PAGE_SIZE = 500;

/** One model's row, found through the list: there is no per-model read yet. Null when no known model has the id. */
export const useAdminModelRow = (id: string) =>
  useQuery({
    queryKey: [...ADMIN_MODELS_QUERY_KEY, 'row', id],
    queryFn: async (): Promise<AdminModelRow | null> => {
      const response = await fetchAdminModels({
        filter: { view: 'all', search: id.slice(0, SEARCH_MAX), showFoundationIds: true },
        pageSize: LOOKUP_PAGE_SIZE,
      });
      return response.models.find(model => model.id === id) ?? null;
    },
    enabled: id.length > 0,
  });

/** Models of one type, for a fallback picker. */
export const useAdminModelsOfType = (type: string | undefined) =>
  useQuery({
    queryKey: [...ADMIN_MODELS_QUERY_KEY, 'of-type', type],
    queryFn: async () =>
      (
        await fetchAdminModels({
          filter: { view: 'all', types: type ? [type] : undefined, showFoundationIds: true },
          sort: 'name',
          pageSize: LOOKUP_PAGE_SIZE,
        })
      ).models,
    enabled: !!type,
  });

/** Distinct user tags with how many accounts hold each, for the tag pickers (GET /api/admin/users/tags). */
export const useAdminUserTags = (enabled = true) =>
  useQuery({
    queryKey: ['admin', 'users', 'tags'],
    queryFn: async () => (await api.get<{ tags: ModelUserTagCount[] }>('/api/admin/users/tags')).data.tags,
    staleTime: 60_000,
    enabled,
  });

/** Tag choices for the access editors: the tags users hold, with counts, plus tags set only on access entries. */
export const useAccessTagOptions = (enabled = true) => {
  const userTags = useAdminUserTags(enabled);
  const entries = useLLMModelConfigurations();
  const options = useMemo(
    () => [
      ...new Set([
        ...(userTags.data ?? []).map(entry => entry.tag),
        ...(entries.data ?? []).flatMap(entry => entry.allowedUserTags ?? []),
      ]),
    ],
    [userTags.data, entries.data]
  );
  const counts = useMemo(() => new Map((userTags.data ?? []).map(entry => [entry.tag, entry.count])), [userTags.data]);
  return {
    options,
    counts,
    isLoading: userTags.isLoading,
    isError: userTags.isError,
    isRetrying: userTags.isFetching,
    retry: () => void userTags.refetch(),
  };
};

/** Refreshes everything that shows access: this console and every open picker in this tab. */
export const useInvalidateModelAccess = () => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ADMIN_MODELS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: LLM_MODEL_CONFIGURATIONS_QUERY_KEY }),
    ]);
};

export const patchModelAccess = async (id: string, body: ModelAccessPatchRequest): Promise<ModelAccessPatchResult> =>
  (await api.patch<ModelAccessPatchResult>('/api/admin/models/access', body, { params: { id } })).data;

export const postModelAccessBulk = async <T extends ModelAccessBulkDryRun | ModelAccessBulkResult>(
  body: ModelAccessBulkRequestInput
): Promise<T> => (await api.post<T>('/api/admin/models/access/bulk', body)).data;

/** A failed API call's status and body, for the endpoints whose 409 and 422 carry data to act on. */
export const apiErrorOf = (error: unknown): { status?: number; data: Record<string, unknown> } => {
  if (!isAxiosError(error)) return { data: {} };
  const data = error.response?.data;
  return {
    status: error.response?.status,
    data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
  };
};

/** The current entry a PATCH 409 carries. */
export const conflictEntryOf = (error: unknown): ModelAccessEntry | null | undefined => {
  const { status, data } = apiErrorOf(error);
  if (status !== 409 || !('entry' in data)) return undefined;
  return (data.entry as ModelAccessEntry | null) ?? null;
};

const ADMIN_LOG_LIMIT = 50;
const PRICE_UNITS = ['per_token', 'per_image', 'per_minute'] as const;

/**
 * Audit entries that name one model, newest first: its access entry, its prices and its lifecycle suggestion. Each
 * write records its own target id (model access, model-prices and model-deprecation-status), so they are read
 * apart and merged.
 */
export const useModelAdminLog = (id: string) => {
  const targetIds = [`llmModelConfigurations:${id}`, ...PRICE_UNITS.map(unit => `${id}:${unit}`), id];
  const results = useQueries({
    queries: targetIds.map(targetId => ({
      queryKey: [...ADMIN_MODELS_QUERY_KEY, 'admin-log', targetId],
      queryFn: async (): Promise<AuditLogPage> => {
        const response = await api.get<{ entries: WireAuditEntry[]; nextCursor: string | null }>(
          '/api/admin/audit-log',
          { params: { targetKind: 'settings', targetId, limit: String(ADMIN_LOG_LIMIT) } }
        );
        return { ...response.data, entries: response.data.entries.map(reviveAuditEntry) };
      },
      enabled: id.length > 0,
    })),
  });
  const entries: AuditEntry[] = results
    .flatMap(result => result.data?.entries ?? [])
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  return {
    entries,
    isLoading: results.some(result => result.isLoading),
    isError: results.some(result => result.isError),
    error: results.find(result => result.error)?.error ?? null,
    /** Some source holds more entries than were read. */
    truncated: results.some(result => !!result.data?.nextCursor),
    refetch: () => Promise.all(results.map(result => result.refetch())),
  };
};
