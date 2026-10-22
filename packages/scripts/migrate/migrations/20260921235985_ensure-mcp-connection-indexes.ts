import { McpConnection, McpOAuthClientRegistration, McpOAuthPending } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the indexes the custom MCP connector collections rely on for integrity, not just speed:
 * - McpConnection `mcpconn_owner_slug` (unique): one slug per owner, so `<slug>__<tool>` is unambiguous.
 * - McpOAuthClientRegistration `mcpoauthclientreg_issuer_redirect` (unique): one DCR client per
 *   authorization server; the repository's E11000 retry assumes it exists.
 * - McpOAuthPending unique `stateHash` and the 600 s TTL on `createdAt`: single-use, self-cleaning
 *   OAuth state.
 * Plus the query indexes declared alongside them.
 *
 * `autoIndex` is off in the deployed environments, so the schema declarations never build there.
 * Must run before the first write to these collections (the c3 CRUD routes); once duplicate slugs
 * or registrations exist this becomes data cleanup.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260921235985,
  name: 'ensure mcp connection indexes',

  up: async () => {
    await McpConnection.createIndexes();
    await McpOAuthPending.createIndexes();
    await McpOAuthClientRegistration.createIndexes();
  },

  down: async () => {
    // One-way. Dropping the unique and TTL indexes would let duplicates and stale OAuth state build up.
  },
};

export default migration;
