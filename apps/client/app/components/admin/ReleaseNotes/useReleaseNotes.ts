import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ModalStillImage, ModalVideo, ReleaseNoteItem, ReleaseNotesConfig } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';

export type ReleaseNoteState = 'scheduled' | 'published' | 'hidden';
export type ReleaseNoteAction = 'hide' | 'unhide' | 'publishNow';

/** Mirrors AdminReleaseNote in packages/server-utils/src/releaseNotes/adminReleaseNotes.ts. */
export interface AdminReleaseNote {
  id: string;
  releaseTag: string;
  headline: string;
  summary: string;
  items: ReleaseNoteItem[];
  video: ModalVideo | null;
  image: ModalStillImage | null;
  state: ReleaseNoteState;
  publishAt: string;
  deployedAt: string;
  deployedSha: string;
  editedAt: string | null;
  deniedTerm: string | null;
}

export type ReleaseNoteEdit = Partial<Pick<AdminReleaseNote, 'headline' | 'summary' | 'items' | 'video' | 'image'>>;

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
    queryFn: async ({ pageParam }) => {
      const response = await api.get<ReleaseNotePage>('/api/admin/release-notes', {
        params: { status, limit: PAGE_SIZE, cursor: pageParam },
      });
      // Keep the clock with the rows: placeholder queries reset dataUpdatedAt to zero.
      return { ...response.data, fetchedAt: Date.now() };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor ?? undefined,
    // A filter switch keeps the previous rows on screen (under an UpdatingBar) until the new list lands.
    placeholderData: keepPreviousData,
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

// The toasts live on the mutation, not the mutate call: per-call callbacks are dropped once the
// edit dialog unmounts, which would leave a save that lands (or fails) after it closes silent.
export function useEditReleaseNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edit }: { id: string; edit: ReleaseNoteEdit }) =>
      (await api.patch<AdminReleaseNote>(`/api/admin/release-notes/${id}`, edit)).data,
    onSuccess: () => {
      toast.success('Release note saved');
      return queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
    onError: err => toast.error(getErrorMessage(err)),
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
