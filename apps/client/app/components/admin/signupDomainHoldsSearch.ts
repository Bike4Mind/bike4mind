// Every key here is shareable: status, reason family and the include-older toggle carry no personal data.
export const SIGNUP_DOMAIN_HOLDS_SEARCH_KEYS = {
  query: 'holdQuery',
  view: 'holdView',
  filters: { status: 'holdStatus', reason: 'holdReason', older: 'holdOlder' },
} as const;
export const SIGNUP_DOMAIN_HOLDS_TAB_PARAMS = Object.values(SIGNUP_DOMAIN_HOLDS_SEARCH_KEYS.filters);
