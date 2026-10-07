// Legacy alias: re-exports the nextRouteForContract handler published as POST /api/v1/image-edits.
// Kept because live callers (and the SPA) use it - CONVENTIONS.md section 3: never remove a live URL.
export { default } from '../v1/image-edits';

// Declared inline, not re-exported: Next reads page `config` statically and ignores a re-export.
export const config = {
  api: {
    externalResolver: true,
  },
};
