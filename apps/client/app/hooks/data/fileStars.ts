import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fabFileKeys } from './fabFileKeys';

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * A cached search narrowed to starred files. Only those lists change when a star does, so the grid
 * the user is looking at is not refetched on every click while the Starred filter is off. The
 * params sit last in every search key (search, searchInfinite, searchPaginated).
 */
function isStarredSearch(query: Query): boolean {
  const params: unknown = query.queryKey.at(-1);
  if (typeof params !== 'object' || params === null || !('filters' in params)) return false;
  const { filters } = params;
  return typeof filters === 'object' && filters !== null && 'starred' in filters && filters.starred === true;
}

/** The caller's starred files (stars are `Favorite` documents of type `files`), as one set for a whole grid. */
export function useStarredFileIds({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: fabFileKeys.starredIds,
    queryFn: async () => {
      const { data } = await api.get<{ fileIds: string[] }>('/api/files/favorites');
      return new Set(data.fileIds);
    },
    enabled,
    refetchOnWindowFocus: false,
  });
  return query.data ?? EMPTY_IDS;
}

/** Stars or unstars one file, optimistically, then refreshes the stars and any starred-filtered search. */
export function useToggleFileStar() {
  const queryClient = useQueryClient();
  return useMutation({
    // Serialized, so a quick star-then-unstar reaches the server in click order and the last click wins.
    scope: { id: 'file-star' },
    mutationFn: async ({ fileId, starred }: { fileId: string; starred: boolean }) => {
      const url = `/api/files/${encodeURIComponent(fileId)}/favorite`;
      await (starred ? api.post(url) : api.delete(url));
    },
    onMutate: async ({ fileId, starred }) => {
      await queryClient.cancelQueries({ queryKey: fabFileKeys.starredIds });
      const previous = queryClient.getQueryData<Set<string>>(fabFileKeys.starredIds);
      const next = new Set(previous);
      if (starred) next.add(fileId);
      else next.delete(fileId);
      queryClient.setQueryData(fabFileKeys.starredIds, next);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      // `previous` is undefined when the stars had not loaded yet; setQueryData ignores undefined.
      queryClient.setQueryData(fabFileKeys.starredIds, context?.previous ?? new Set<string>());
      toast.error('Could not update the star');
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: fabFileKeys.starredIds }),
        queryClient.invalidateQueries({ queryKey: fabFileKeys.searchAll, predicate: isStarredSearch }),
      ]),
  });
}

/** The distinct generation model ids behind the caller's own files, sorted, for a model filter. */
export function useGenerationModelIds({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fabFileKeys.generationModels,
    queryFn: async () => {
      const { data } = await api.get<{ modelIds: string[] }>('/api/files/generation-models');
      return data.modelIds;
    },
    enabled,
    refetchOnWindowFocus: false,
  });
}
