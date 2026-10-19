// Lightweight entry (`@bike4mind/fab-pipeline/ssrf`): node built-ins and undici only, so a consumer such as
// `@bike4mind/mcp` gets the SSRF primitives without loading the ingest, storage and embeddings graph.
export * from './ssrfProtection';
export * from './pinnedFetch';
