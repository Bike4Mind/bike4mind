import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReleaseNoteItem, ReleaseNotesConfig } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export type ReleaseNoteState = 'scheduled' | 'published' | 'hidden';
export type ReleaseNoteAction = 'hide' | 'unhide' | 'publishNow';

/** Mirrors AdminReleaseNote in apps/client/server/releaseNotes/adminReleaseNotes.ts. */
export interface AdminReleaseNote {
  id: string;
  releaseTag: string;
  headline: string;
  summary: string;
  items: ReleaseNoteItem[];
  state: ReleaseNoteState;
  publishAt: string;
  deployedAt: string;
  deployedSha: string;
  editedAt: string | null;
  deniedTerm: string | null;
}

export type ReleaseNoteEdit = Partial<Pick<AdminReleaseNote, 'headline' | 'summary' | 'items'>>;

interface ReleaseNotePage {
  data: AdminReleaseNote[];
  next_cursor: string | null;
}

const LIST_KEY = ['admin', 'release-notes'] as const;
const CONFIG_KEY = ['admin', 'release-notes-config'] as const;
const PAGE_SIZE = 20;

export function useReleaseNotes(status: ReleaseNoteState) {
  return useInfiniteQuery({
    queryKey: [...LIST_KEY, status],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<ReleaseNotePage>('/api/admin/release-notes', {
          params: { status, limit: PAGE_SIZE, cursor: pageParam },
        })
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor ?? undefined,
  });
}

// A status change moves a note between filters, so every status list is refetched.
export function useReleaseNoteStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, action }: { id: string; action: ReleaseNoteAction }) =>
      (await api.post<AdminReleaseNote>(`/api/admin/release-notes/${id}/status`, { action })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

export function useEditReleaseNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edit }: { id: string; edit: ReleaseNoteEdit }) =>
      (await api.patch<AdminReleaseNote>(`/api/admin/release-notes/${id}`, edit)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

interface ConfigResponse {
  config: ReleaseNotesConfig;
  malformed: boolean;
}

export function useReleaseNotesConfig() {
  return useQuery({
    queryKey: CONFIG_KEY,
    queryFn: async () => (await api.get<ConfigResponse>('/api/admin/release-notes/config')).data,
  });
}

export function useSaveReleaseNotesConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: ReleaseNotesConfig) =>
      (await api.put<ConfigResponse>('/api/admin/release-notes/config', config)).data,
    onSuccess: data => queryClient.setQueryData(CONFIG_KEY, data),
  });
}
