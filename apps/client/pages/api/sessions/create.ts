// Legacy alias: re-exports the nextRouteForContract handler published as POST /api/v1/sessions.
// Kept because live callers (and the SPA) use it - CONVENTIONS.md section 3: never remove a live URL.
export { default } from '../v1/sessions';

// Declared inline, not re-exported: Next reads page `config` statically and ignores a re-export.
export const config = {
  api: {
    externalResolver: true,
  },
};
