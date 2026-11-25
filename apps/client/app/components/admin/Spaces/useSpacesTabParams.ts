import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { SPACES_ID_PARAM, spacesViewFromSearch, spacesViewToSearch, type SpacesView } from './spacesTabSearch';

type SearchRecord = Record<string, unknown>;

const ADMIN_PATH = '/admin';

/** The list view (page, page size, sort) lives in the URL. The search text does not: it may be an email. */
export const useSpacesView = (): readonly [SpacesView, (patch: Partial<SpacesView>) => void] => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const view = useMemo(() => spacesViewFromSearch(search), [search]);

  const setView = useCallback(
    (patch: Partial<SpacesView>) => {
      void navigate({
        to: ADMIN_PATH,
        replace: true,
        search: (previous: SearchRecord) => ({
          ...previous,
          ...spacesViewToSearch({ ...spacesViewFromSearch(previous), ...patch }),
        }),
      });
    },
    [navigate]
  );

  return [view, setView] as const;
};

/** The Space open in the detail modal, kept in `?spaceId=` so a refresh or a link reopens it. */
export const useOpenSpaceId = () => {
  const spaceId = useSearch({
    strict: false,
    select: search => (search as SearchRecord)[SPACES_ID_PARAM],
  });
  const navigate = useNavigate();

  const setSpaceId = useCallback(
    (id: string | null) =>
      navigate({
        to: ADMIN_PATH,
        search: (previous: SearchRecord) => ({ ...previous, [SPACES_ID_PARAM]: id ?? undefined }),
        replace: true,
      }),
    [navigate]
  );

  return { spaceId: typeof spaceId === 'string' ? spaceId : null, setSpaceId };
};
