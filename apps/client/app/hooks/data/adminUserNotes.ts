import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminUserNote, AdminUserNoteRevision, AdminUserNotesPage } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';

export const useAdminUserNotes = (userId: string, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'notes'],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<AdminUserNotesPage>(`/api/admin/users/${userId}/notes`, {
          params: { cursor: pageParam, limit: 25 },
        })
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: AdminUserNotesPage) => page.nextCursor ?? undefined,
    enabled,
  });

export const useAdminUserNoteHistory = (userId: string, noteId: string) =>
  useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'notes', noteId, 'history'],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<{ entries: AdminUserNoteRevision[]; nextCursor: string | null }>(
          `/api/admin/users/${userId}/notes`,
          { params: { noteId, cursor: pageParam, limit: 25 } }
        )
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
  });

type NoteAction = { body: string } | { noteId: string; version: number; body?: string; deleted?: boolean };
export const useWriteAdminUserNote = (userId: string) => {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (input: NoteAction) =>
      (
        await api.request<AdminUserNote>({
          url: `/api/admin/users/${userId}/notes`,
          method: 'noteId' in input ? 'PATCH' : 'POST',
          data: input,
        })
      ).data,
    onSuccess: () => cache.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
    onError: () => {
      toast.error('The note was not saved. Reload notes and try again.');
      void cache.invalidateQueries({ queryKey: ['admin', 'users', userId, 'notes'] });
    },
  });
};
