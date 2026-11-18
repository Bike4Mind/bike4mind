export type SideAppRefusalClass = 'policy' | 'app_fault' | 'our_fault';

/**
 * Who a refusal reason points at. Policy refusals are expected, app faults are the app's own
 * mistakes, our faults are ours. Shared by the admin board and the health alerts.
 */
export const SIDE_APP_REFUSAL_CLASS: Readonly<Record<string, SideAppRefusalClass>> = {
  subscription_required: 'policy',
  invalid_scope: 'policy',
  access_denied: 'policy',
  insufficient_scope: 'policy',
  route_not_allowed: 'policy',
  invalid_grant: 'app_fault',
  invalid_request: 'app_fault',
  invalid_client: 'app_fault',
  rate_limited: 'app_fault',
  idp_unavailable: 'app_fault',
  temporarily_unavailable: 'our_fault',
  server_error: 'our_fault',
};

/** A reason missing from the map is surfaced as our fault so it gets looked at, not hidden as policy. */
export function classifySideAppRefusal(reason: string): SideAppRefusalClass {
  return SIDE_APP_REFUSAL_CLASS[reason] ?? 'our_fault';
}
