// Lambda entry for mcpHandler (infra/mcp.ts). It stays in apps/client so SST bundles it and
// resolves its nodejs.install versions against apps/client's package.json, as before the move.
export * from '@bike4mind/server-utils/utils/mcpCall';
