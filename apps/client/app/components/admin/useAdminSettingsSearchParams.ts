import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { SETTING_TABS } from '@bike4mind/common';
import { ADMIN_SETTINGS_SEARCH_PARAM, ADMIN_SETTINGS_SECTION_PARAM, type AdminSearch } from './adminTabParams';

export type SettingSectionKey = keyof typeof SETTING_TABS;

const SECTION_ENTRIES = Object.entries(SETTING_TABS) as Array<
  [SettingSectionKey, (typeof SETTING_TABS)[SettingSectionKey]]
>;

const DEFAULT_SETTING_SECTION: SettingSectionKey = SECTION_ENTRIES[0][0];

// The URL carries each section's `id` ('aiConfiguration'), the slug-shaped field, not its object key.
const sectionFromId = (id: string | undefined): SettingSectionKey =>
  SECTION_ENTRIES.find(([, section]) => section.id === id)?.[0] ?? DEFAULT_SETTING_SECTION;

/**
 * The Admin Settings tab's section and search term, kept in `?section=` and `?q=` so a refresh or a
 * shared link reopens the same view. Setting values never go in the URL.
 *
 * The section reads straight from the URL. The search box keeps its own state, seeded from the URL,
 * because binding a text input to the router would re-render it a navigation behind each keystroke.
 * Leaving the tab needs no cleanup here: the tab-sync hook rebuilds the search from the param
 * registry and drops these keys.
 */
export const useAdminSettingsSearchParams = () => {
  const search = useSearch({ strict: false }) as AdminSearch;
  const navigate = useNavigate();
  const urlSearchTerm = search[ADMIN_SETTINGS_SEARCH_PARAM] ?? '';
  const [searchTerm, setSearchTermState] = useState(() => urlSearchTerm);
  // The last term this hook pushed to the URL, so its own echo does not re-seed the box.
  const writtenTermRef = useRef(urlSearchTerm);

  // Follow a `q` that changed from outside while the tab stayed mounted (back/forward, a
  // navigation from another surface): the box and the URL must not disagree.
  useEffect(() => {
    if (urlSearchTerm === writtenTermRef.current) return;
    writtenTermRef.current = urlSearchTerm;
    setSearchTermState(urlSearchTerm);
  }, [urlSearchTerm]);

  const section = sectionFromId(search[ADMIN_SETTINGS_SECTION_PARAM]);

  const writeSearch = useCallback(
    (patch: AdminSearch) => {
      navigate({ to: '/admin', search: (previous: AdminSearch) => ({ ...previous, ...patch }), replace: true });
    },
    [navigate]
  );

  const setSection = useCallback(
    (key: SettingSectionKey) => writeSearch({ [ADMIN_SETTINGS_SECTION_PARAM]: SETTING_TABS[key].id }),
    [writeSearch]
  );

  const setSearchTerm = useCallback(
    (term: string) => {
      writtenTermRef.current = term;
      setSearchTermState(term);
      writeSearch({ [ADMIN_SETTINGS_SEARCH_PARAM]: term || undefined });
    },
    [writeSearch]
  );

  return { section, setSection, searchTerm, setSearchTerm };
};
