import { lakeMembershipChangeEventRepository } from '@bike4mind/database';

/**
 * The audit half of every lake MEMBERSHIP-write service's `db` adapters, mirroring
 * `lakeConfigAuditDb` and for the identical reason: one place to spread from, so no route that
 * drives a membership-write service (`addFileToDataLake`, `removeFileFromDataLake`, `toggleTags`,
 * `reconcileLakeTags`, `executeLakeMembershipRepair`) can drift into wiring the write but not the
 * audit, which would be invisible - the services treat the repository as optional and silently
 * record nothing when it is absent (see `LakeMembershipAuditAdapters`).
 *
 * Spread it into a service's `db`, e.g.
 *   db: { dataLakes: dataLakeRepository, ...lakeMembershipAuditDb }
 *
 * Frozen for the same reason `lakeConfigAuditDb` is: module-level shared state spread into every
 * audited write path, so a stray mutation anywhere would silently repoint the audit for all of
 * them at once.
 */
export const lakeMembershipAuditDb = Object.freeze({
  lakeMembershipChangeEvents: lakeMembershipChangeEventRepository,
});
