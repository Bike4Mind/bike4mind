import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  DEFAULT_SECURITY_SCAN,
  DEFAULT_SECURITY_VIEW,
  SECURITY_DASHBOARD_SEARCH_PARSERS as parsers,
  SECURITY_SCAN_PARAM,
  SECURITY_VIEW_PARAM,
  type SecurityScan,
  type SecurityView,
} from '../securityDashboardSearch';

type SearchRecord = Record<string, unknown>;

/**
 * The Security tab's view and scan panel, owned by the URL. A default is written as undefined so a
 * bare `?tab=security-dashboard` opens the incident view. Leaving the tab needs no cleanup: the
 * tab-sync rebuild in useAdminTabUrlSync drops these keys through the param registry.
 */
export function useSecurityDashboardSearch() {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const view = parsers[SECURITY_VIEW_PARAM](search[SECURITY_VIEW_PARAM]) ?? DEFAULT_SECURITY_VIEW;
  const scan = parsers[SECURITY_SCAN_PARAM](search[SECURITY_SCAN_PARAM]) ?? DEFAULT_SECURITY_SCAN;

  const write = useCallback(
    (nextView: SecurityView, nextScan: SecurityScan | undefined) => {
      navigate({
        to: '/admin',
        search: (previous: SearchRecord) => ({
          ...previous,
          [SECURITY_VIEW_PARAM]: nextView === DEFAULT_SECURITY_VIEW ? undefined : nextView,
          [SECURITY_SCAN_PARAM]: nextScan === DEFAULT_SECURITY_SCAN ? undefined : nextScan,
        }),
        replace: true,
      });
    },
    [navigate]
  );

  const setView = useCallback(
    (next: SecurityView) => {
      if (next !== view) write(next, undefined);
    },
    [view, write]
  );

  const setScan = useCallback((next: SecurityScan) => write('scans', next), [write]);

  return { view, scan, setView, setScan };
}
