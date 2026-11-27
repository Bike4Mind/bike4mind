import { lakeMembershipRemovalRepository } from '@bike4mind/database';
import { lakeConfigAuditDb } from './lakeConfigAuditDb';
import { lakeMembershipAuditDb } from './lakeMembershipAuditDb';

/**
 * The tool-host `db` adapters the lake-writing tools (save_content_to_data_lake, create_data_lake)
 * read on top of a host's base repositories. saveContentAdapters (b4m-core/services, dataLakeContent
 * /adapters.ts) returns null when any is missing, so a host that omits one answers "not available on
 * this surface" instead of writing. Every host that offers those tools spreads this, so they cannot
 * drift apart; embedRoute.ts does not, since no embed opt-in tool writes a lake (embedToolResolver.ts).
 */
export const lakeWriteToolDb = Object.freeze({
  memoryLedger: lakeMembershipAuditDb.memoryLedger,
  lakeMembershipRemovals: lakeMembershipRemovalRepository,
  lakeConfigChangeEvents: lakeConfigAuditDb.lakeConfigChangeEvents,
  lakeMembershipChangeEvents: lakeMembershipAuditDb.lakeMembershipChangeEvents,
});
