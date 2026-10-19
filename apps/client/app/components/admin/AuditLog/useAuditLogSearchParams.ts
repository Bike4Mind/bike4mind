import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import {
  ADMIN_AUDIT_LOG_TAB_SLUG,
  ADMIN_TAB_PARAM,
  AUDIT_ENTRY_ID_PARAM,
  AuditLogFiltersSchema,
  type AuditLogFilters,
} from '@bike4mind/common';

const FILTER_KEYS = Object.keys(AuditLogFiltersSchema.shape) as Array<keyof AuditLogFilters>;

const ADMIN_PATH = '/admin';

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
  const router = useRouter();
  const pendingCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filters = useMemo(() => parseFilters(search), [search]);
  const entryId = typeof search[AUDIT_ENTRY_ID_PARAM] === 'string' ? (search[AUDIT_ENTRY_ID_PARAM] as string) : null;

  const writeSearch = useCallback(
    (update: (previous: SearchRecord) => SearchRecord) => {
      navigate({ to: ADMIN_PATH, search: update as never, replace: true });
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
  // removed (tab only when it is ours), so unrelated params survive. The strip is deferred a tick so a
  // StrictMode mount/cleanup/mount cancels it instead of wiping deep-link filters, and it is skipped
  // once the router has left /admin so it never drags the user back from another route.
  useEffect(() => {
    if (pendingCleanupRef.current !== null) {
      clearTimeout(pendingCleanupRef.current);
      pendingCleanupRef.current = null;
    }
    return () => {
      pendingCleanupRef.current = setTimeout(() => {
        pendingCleanupRef.current = null;
        if (router.state.location.pathname !== ADMIN_PATH) return;
        writeSearch(previous => ({
          ...previous,
          [ADMIN_TAB_PARAM]:
            previous[ADMIN_TAB_PARAM] === ADMIN_AUDIT_LOG_TAB_SLUG ? undefined : previous[ADMIN_TAB_PARAM],
          [AUDIT_ENTRY_ID_PARAM]: undefined,
          ...filterKeysOf({}),
        }));
      }, 0);
    };
  }, [router, writeSearch]);

  return { filters, entryId, setFilters, patchFilters, openEntry };
};
