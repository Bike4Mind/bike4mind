import { USER_TIMELINE_TYPES, type UserTimelineType } from '@bike4mind/common';

/**
 * The Activity tab's filters in the profile URL (`?tab=activity&types=signin,admin&from=...&to=...`).
 * Pure and React-free: userProfileSearch.ts, which router.tsx imports eagerly, spreads it in.
 * Absent `types` means every source; days are inclusive UTC calendar days.
 */
export type ActivitySearch = { types?: string; from?: string; to?: string };

export type ActivityFilters = { types: UserTimelineType[]; from?: string; to?: string };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isTimelineType = (value: string): value is UserTimelineType =>
  (USER_TIMELINE_TYPES as readonly string[]).includes(value);

const parseDay = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? value : undefined;
};

/** Keeps the known, de-duplicated types in canonical order; none left (or all) means "every source". */
const parseTypes = (value: unknown): UserTimelineType[] | undefined => {
  if (typeof value !== 'string') return undefined;
  const requested = new Set(value.split(',').filter(isTimelineType));
  const types = USER_TIMELINE_TYPES.filter(type => requested.has(type));
  return types.length === 0 || types.length === USER_TIMELINE_TYPES.length ? undefined : types;
};

/** Each key is returned, possibly as undefined, so a dropped value cannot leak through from the raw query. */
export const parseActivitySearch = (search: Record<string, unknown>): ActivitySearch => {
  const types = parseTypes(search.types);
  let from = parseDay(search.from);
  let to = parseDay(search.to);
  if (from && to && from > to) [from, to] = [to, from];
  return { types: types?.join(','), from, to };
};

export const activityFiltersFromSearch = (search: ActivitySearch): ActivityFilters => ({
  types: parseTypes(search.types) ?? [...USER_TIMELINE_TYPES],
  from: parseDay(search.from),
  to: parseDay(search.to),
});

export const activitySearchFromFilters = (filters: ActivityFilters): ActivitySearch =>
  parseActivitySearch({ types: filters.types.join(','), from: filters.from, to: filters.to });
