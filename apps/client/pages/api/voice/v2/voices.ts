// Legacy alias: re-exports the nextRouteForContract handler published as GET /api/v1/voice/voices.
// Kept because live callers (and the SPA) use it - CONVENTIONS.md section 3: never remove a live URL.
export { default } from '../../v1/voice/voices';
