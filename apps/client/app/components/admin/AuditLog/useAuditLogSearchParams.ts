import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  ADMIN_AUDIT_LOG_TAB_SLUG,
  ADMIN_TAB_PARAM,
  AUDIT_ENTRY_ID_PARAM,
  AuditLogFiltersSchema,
  type AuditLogFilters,
} from '@bike4mind/common';

const FILTER_KEYS = Object.keys(AuditLogFiltersSchema.shape) as Array<keyof AuditLogFilters>;

type SearchRecord = Record<string, unknown>;

const parseFilters = (search: SearchRecord): AuditLogFilters => {
  const filters: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const parsed = AuditLogFiltersSchema.shape[key].safeParse(search[key]);
    if (parsed.success && parsed.data !== undefined) filters[key] = parsed.data;
  }
  return filters as AuditLogFilters;
};

const filterKeysOf = (filters: AuditLogFilters): SearchRecord =>
  Object.fromEntries(FILTER_KEYS.map(key => [key, filters[key]]));

/** The URL is the source of truth for the page's filters and the open entry. */
export const useAuditLogSearchParams = () => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();

  const filters = useMemo(() => parseFilters(search), [search]);
  const entryId = typeof search[AUDIT_ENTRY_ID_PARAM] === 'string' ? (search[AUDIT_ENTRY_ID_PARAM] as string) : null;

  const writeSearch = useCallback(
    (update: (previous: SearchRecord) => SearchRecord) => {
      navigate({ to: '/admin', search: update as never, replace: true });
    },
    [navigate]
  );

  const setFilters = useCallback(
    (next: AuditLogFilters) =>
      writeSearch(previous => ({
        ...previous,
        [ADMIN_TAB_PARAM]: ADMIN_AUDIT_LOG_TAB_SLUG,
        [AUDIT_ENTRY_ID_PARAM]: undefined,
        ...filterKeysOf(next),
      })),
    [writeSearch]
  );

  const patchFilters = useCallback(
    (patch: Partial<AuditLogFilters>) =>
      writeSearch(previous => ({
        ...previous,
        [ADMIN_TAB_PARAM]: ADMIN_AUDIT_LOG_TAB_SLUG,
        [AUDIT_ENTRY_ID_PARAM]: undefined,
        ...filterKeysOf({ ...parseFilters(previous), ...patch }),
      })),
    [writeSearch]
  );

  const openEntry = useCallback(
    (id: string | null) =>
      writeSearch(previous => ({
        ...previous,
        [ADMIN_TAB_PARAM]: ADMIN_AUDIT_LOG_TAB_SLUG,
        [AUDIT_ENTRY_ID_PARAM]: id ?? undefined,
      })),
    [writeSearch]
  );

  // Leaving the tab must not leave stale filters in the URL for the next tab. Only our keys are
  // removed (tab only when it is ours), so unrelated params survive.
  useEffect(
    () => () =>
      writeSearch(previous => ({
        ...previous,
        [ADMIN_TAB_PARAM]:
          previous[ADMIN_TAB_PARAM] === ADMIN_AUDIT_LOG_TAB_SLUG ? undefined : previous[ADMIN_TAB_PARAM],
        [AUDIT_ENTRY_ID_PARAM]: undefined,
        ...filterKeysOf({}),
      })),
    [writeSearch]
  );

  return { filters, entryId, setFilters, patchFilters, openEntry };
};
