import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { feedbackViewFromSearch, feedbackViewToSearch, type FeedbackView } from '../feedbackTabSearch';

type SearchRecord = Record<string, unknown>;

export type FeedbackViewPatch = Partial<FeedbackView> | ((current: FeedbackView) => Partial<FeedbackView>);

/**
 * The Feedback tab's list view (status, subject, org, sort, page, page size), owned by the URL.
 * Writes use `replace` and are computed from the URL at write time, so a patch that also resets the
 * page lands as one navigation. Leaving the tab needs no cleanup: the tab-sync rebuild in
 * useAdminTabUrlSync drops these keys through the param registry.
 */
export const useFeedbackView = (): readonly [FeedbackView, (patch: FeedbackViewPatch) => void] => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const view = useMemo(() => feedbackViewFromSearch(search), [search]);

  const updateView = useCallback(
    (patch: FeedbackViewPatch) => {
      navigate({
        to: '/admin',
        search: (previous: SearchRecord) => {
          const current = feedbackViewFromSearch(previous);
          const changes = typeof patch === 'function' ? patch(current) : patch;
          return { ...previous, ...feedbackViewToSearch({ ...current, ...changes }) };
        },
        replace: true,
      });
    },
    [navigate]
  );

  return [view, updateView] as const;
};
