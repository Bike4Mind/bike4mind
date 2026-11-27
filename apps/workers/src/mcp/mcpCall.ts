// Lambda entry for mcpHandler (infra/mcp.ts). SST resolves its nodejs.install versions from
// apps/workers/package.json `dependencies`, so each installed package must be declared there.
export * from '@bike4mind/server-utils/utils/mcpCall';
