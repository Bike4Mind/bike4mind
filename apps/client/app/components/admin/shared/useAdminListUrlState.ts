import { useNavigate, useSearch } from '@tanstack/react-router';
import { z } from 'zod';

export type AdminListState = { query: string; filters: Record<string, string>; view: string };
export type AdminListSearchKeys = { query: string; view: string; filters: Record<string, string> };
const searchValue = (value: unknown) => z.string().max(500).catch('').parse(value);

export function readAdminListState(search: Record<string, unknown>, keys: AdminListSearchKeys): AdminListState {
  return {
    query: searchValue(search[keys.query]),
    view: searchValue(search[keys.view]),
    filters: Object.fromEntries(Object.entries(keys.filters).map(([name, key]) => [name, searchValue(search[key])])),
  };
}

/** Register these keys in adminTabParams.ts; only persist searches that contain no personal data. */
export function useAdminListUrlState(
  keys: AdminListSearchKeys
): readonly [AdminListState, (patch: Partial<AdminListState>) => void] {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const state = readAdminListState(search, keys);
  const update = (patch: Partial<AdminListState>) => {
    void navigate({
      to: '/admin',
      replace: true,
      search: (previous: Record<string, unknown>) => {
        const next = { ...readAdminListState(previous, keys), ...patch };
        return {
          ...previous,
          [keys.query]: next.query || undefined,
          [keys.view]: next.view || undefined,
          ...Object.fromEntries(
            Object.entries(keys.filters).map(([name, key]) => [key, next.filters[name] || undefined])
          ),
        };
      },
    });
  };
  return [state, update];
}
