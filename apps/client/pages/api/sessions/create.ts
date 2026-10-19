// Legacy alias: re-exports the nextRouteForContract handler published as POST /api/v1/sessions.
// Kept because live callers (and the SPA) use it - CONVENTIONS.md section 3: never remove a live URL.
// The POST router only, not the v1 page's default: that also serves GET (listSessions), which
// this legacy URL never answered.
export { createSessionRouter as default } from '../v1/sessions';

// Declared inline, not re-exported: Next reads page `config` statically and ignores a re-export.
export const config = {
  api: {
    externalResolver: true,
  },
};
