// query is never written to the URL: it searches emails, and admin URLs get shared (see adminTabParams.ts).
export const SIGNUP_RISK_REVIEW_SEARCH_KEYS = {
  query: 'riskQuery',
  view: 'riskView',
  filters: { domain: 'riskDomain', signal: 'riskSignal' },
} as const;
export const SIGNUP_RISK_REVIEW_TAB_PARAMS = Object.values(SIGNUP_RISK_REVIEW_SEARCH_KEYS.filters);
