import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getServerErrorField } from '@client/app/utils/error';
import { api } from '@client/app/contexts/ApiContext';
import type {
  AdminSavedViewsListResponse,
  CreateAdminSavedViewRequest,
  UpdateAdminSavedViewRequest,
} from '@client/app/utils/adminSavedViews';
import type { UsersListParams } from '../usersTabSearch';
import { toUsersSavedView, type UsersSavedViewItem } from './usersSavedViews';

const SAVED_VIEWS_PATH = '/api/admin/saved-views';
export const usersSavedViewsQueryKey = ['admin-saved-views', 'users'] as const;

/** The server's message for a failed saved-view request (409 duplicate name, 400 cap), else a fallback. */
export const savedViewErrorMessage = (error: unknown): string =>
  getServerErrorField(error) || 'Could not save the view. Try again.';

/** The admin's own users-list views plus every shared one, by name. */
export function useUsersSavedViews() {
  return useQuery({
    queryKey: usersSavedViewsQueryKey,
    queryFn: async () => {
      const { data } = await api.get<AdminSavedViewsListResponse<'users'>>(SAVED_VIEWS_PATH, {
        params: { surface: 'users' },
      });
      return data.views;
    },
    staleTime: 60_000,
  });
}

const useInvalidateSavedViews = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: usersSavedViewsQueryKey });
};

export function useCreateUsersSavedView() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSavedViews();
  return useMutation({
    mutationFn: async ({ name, shared, params }: { name: string; shared: boolean; params: UsersListParams }) => {
      const request: CreateAdminSavedViewRequest = { surface: 'users', name, shared, view: toUsersSavedView(params) };
      const { data } = await api.post<UsersSavedViewItem>(SAVED_VIEWS_PATH, request);
      return data;
    },
    // Into the cache before the refetch lands, so the new tab is there (and active) at once.
    onSuccess: created => {
      queryClient.setQueryData<UsersSavedViewItem[]>(usersSavedViewsQueryKey, views =>
        [...(views ?? []), created].sort((a, b) => a.name.localeCompare(b.name))
      );
      return invalidate();
    },
  });
}

export function useUpdateUsersSavedView() {
  const invalidate = useInvalidateSavedViews();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateAdminSavedViewRequest }) => {
      const { data } = await api.patch<UsersSavedViewItem>(`${SAVED_VIEWS_PATH}/${id}`, patch);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteUsersSavedView() {
  const invalidate = useInvalidateSavedViews();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`${SAVED_VIEWS_PATH}/${id}`);
    },
    onSuccess: invalidate,
  });
}
