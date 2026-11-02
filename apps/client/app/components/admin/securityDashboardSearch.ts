import { oneOf } from './adminSearchValues';

/**
 * The Security tab's `/admin` search params and their coercion. Pure and React-free:
 * adminTabParams.ts (and through it router.tsx's eager import) reads it. Prefixed because the
 * registry gives every param exactly one owner and bare names like `view` are too generic to claim.
 */

export const SECURITY_VIEW_PARAM = 'securityView';
/** The scan panel open inside the Scans view. */
export const SECURITY_SCAN_PARAM = 'securityScan';

export const SECURITY_DASHBOARD_TAB_PARAMS = [SECURITY_VIEW_PARAM, SECURITY_SCAN_PARAM] as const;

export const SECURITY_VIEWS = ['incident', 'firewall', 'scans'] as const;
export type SecurityView = (typeof SECURITY_VIEWS)[number];
export const DEFAULT_SECURITY_VIEW: SecurityView = 'incident';

export const SECURITY_SCANS = ['web', 'cloud', 'prowler', 'active-defense'] as const;
export type SecurityScan = (typeof SECURITY_SCANS)[number];
export const DEFAULT_SECURITY_SCAN: SecurityScan = 'web';

export type SecurityDashboardSearch = {
  [SECURITY_VIEW_PARAM]?: SecurityView;
  [SECURITY_SCAN_PARAM]?: SecurityScan;
};

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const SECURITY_DASHBOARD_SEARCH_PARSERS: {
  readonly [K in keyof SecurityDashboardSearch]-?: (value: unknown) => SecurityDashboardSearch[K];
} = {
  [SECURITY_VIEW_PARAM]: oneOf(SECURITY_VIEWS),
  [SECURITY_SCAN_PARAM]: oneOf(SECURITY_SCANS),
};
