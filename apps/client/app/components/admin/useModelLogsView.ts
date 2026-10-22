import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { modelLogsViewFromSearch, modelLogsViewToSearch, type ModelLogsView } from './modelLogsTabSearch';

type SearchRecord = Record<string, unknown>;

/**
 * The Model Logs tab's view (page, page size, date range, model), owned by the URL. Writes use
 * `replace` and are computed from the URL at write time, so a filter change that also resets the
 * page lands as one navigation. Leaving the tab needs no cleanup: the tab-sync rebuild in
 * useAdminTabUrlSync drops these keys through the param registry.
 */
export const useModelLogsView = (): readonly [ModelLogsView, (patch: Partial<ModelLogsView>) => void] => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const view = useMemo(() => modelLogsViewFromSearch(search), [search]);

  const updateView = useCallback(
    (patch: Partial<ModelLogsView>) => {
      navigate({
        to: '/admin',
        search: (previous: SearchRecord) => ({
          ...previous,
          ...modelLogsViewToSearch({ ...modelLogsViewFromSearch(previous), ...patch }),
        }),
        replace: true,
      });
    },
    [navigate]
  );

  return [view, updateView] as const;
};
