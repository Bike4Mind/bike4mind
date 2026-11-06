// Legacy alias for the nextRouteForContract handler at POST /api/v1/sessions/semantic-search.
// Kept because live callers (the SPA and the CLI) use it - CONVENTIONS.md section 3: never remove a live URL.
export { default } from '../v1/sessions/semantic-search';

export const config = {
  api: {
    externalResolver: true,
  },
};
