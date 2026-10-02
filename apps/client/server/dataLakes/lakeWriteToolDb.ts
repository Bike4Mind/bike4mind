import { lakeMembershipRemovalRepository } from '@bike4mind/database';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';

/**
 * The tool-host `db` adapters the lake-writing tools (save_content_to_data_lake, create_data_lake)
 * read on top of a host's base repositories. saveContentAdapters (b4m-core/services, dataLakeContent
 * /adapters.ts) returns null when any is missing, so a host that omits one answers "not available on
 * this surface" instead of writing. Every tool host spreads this, so they cannot drift apart.
 */
export const lakeWriteToolDb = Object.freeze({
  lakeMembershipRemovals: lakeMembershipRemovalRepository,
  lakeConfigChangeEvents: lakeConfigAuditDb.lakeConfigChangeEvents,
  lakeMembershipChangeEvents: lakeMembershipAuditDb.lakeMembershipChangeEvents,
});
