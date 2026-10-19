import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IModalDocument, PublicReleaseNote } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { releaseNoteToModal } from '@client/app/components/modals/releaseNoteSlides';
import { useGetModals } from './modals';

const RELEASE_NOTE_SLIDE_LIMIT = 5;

/** Latest published release notes as What's New slides. Failures are silent: the slider still has its modals. */
export function useReleaseNoteSlides() {
  const currentUser = useUser(s => s.currentUser);
  return useQuery({
    queryKey: ['whats-new', 'release-note-slides', RELEASE_NOTE_SLIDE_LIMIT],
    enabled: !!currentUser,
    queryFn: async () => {
      const { data } = await api.get<{ data: PublicReleaseNote[] }>(
        `/api/v1/whats-new?limit=${RELEASE_NOTE_SLIDE_LIMIT}`
      );
      return (data?.data ?? []).map(releaseNoteToModal);
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}

const merge = (modals: IModalDocument[] | undefined, slides: IModalDocument[] | undefined) =>
  modals ? [...modals, ...(slides ?? [])] : undefined;

/**
 * useGetModals() plus release-note slides. `data` waits only on the modals query, so a slow or failed
 * feed never holds back hand-authored modals. AdminModalTab and NotebookSplash still call useGetModals().
 */
export function useModalsWithReleaseNotes() {
  const modals = useGetModals();
  const slides = useReleaseNoteSlides();
  const { refetch: refetchModals } = modals;
  const { refetch: refetchSlides } = slides;

  const data = useMemo(() => merge(modals.data, slides.data), [modals.data, slides.data]);

  const refetch = useCallback(async () => {
    const [freshModals, freshSlides] = await Promise.all([refetchModals(), refetchSlides()]);
    return { data: merge(freshModals.data, freshSlides.data) };
  }, [refetchModals, refetchSlides]);

  return { data, isPending: modals.isPending, slidesPending: slides.isPending, refetch };
}
