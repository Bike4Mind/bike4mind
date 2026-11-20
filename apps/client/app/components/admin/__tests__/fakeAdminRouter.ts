import { useSyncExternalStore } from 'react';
import { vi } from 'vitest';
import { parseAdminSearch } from '../adminTabParams';

type SearchRecord = Record<string, unknown>;
type NavigateOptions = {
  to: string;
  replace?: boolean;
  search: SearchRecord | ((previous: SearchRecord) => SearchRecord);
};

/**
 * A stand-in for the `/admin` route's search state: navigate applies the update and runs it through
 * the route's real `validateSearch`, and useSearch re-renders on change, so tests exercise the
 * URL round trip rather than a frozen mock. Use with
 * `vi.mock('@tanstack/react-router', async () => (await import('<relative>/__tests__/fakeAdminRouter')).fakeRouterModule)`.
 */
let currentSearch: SearchRecord = {};
let currentPathname = '/admin';
const listeners = new Set<() => void>();

const validate = (search: SearchRecord): SearchRecord =>
  Object.fromEntries(Object.entries(parseAdminSearch(search)).filter(([, value]) => value !== undefined));

const setSearch = (next: SearchRecord) => {
  currentSearch = validate(next);
  listeners.forEach(listener => listener());
};

export const fakeAdminRouter = {
  get search(): SearchRecord {
    return currentSearch;
  },
  reset: (search: SearchRecord = {}, pathname = '/admin') => {
    currentPathname = pathname;
    setSearch(search);
    fakeAdminRouter.navigate.mockClear();
  },
  navigate: vi.fn((options: NavigateOptions) => {
    setSearch(typeof options.search === 'function' ? options.search(currentSearch) : options.search);
  }),
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const fakeRouterModule = {
  useRouter: () => ({ state: { location: { pathname: currentPathname, search: currentSearch } } }),
  useSearch: ({ select }: { select?: (search: SearchRecord) => unknown } = {}) => {
    const search = useSyncExternalStore(subscribe, () => currentSearch);
    return select ? select(search) : search;
  },
  useNavigate: () => fakeAdminRouter.navigate,
};
