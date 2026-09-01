import { adminSettingsRepository, lakeConfigChangeEventRepository } from '@bike4mind/database';

/**
 * The audit half of every lake CONFIG-write service's `db` adapters, in one place so no route that
 * drives those services can drift into wiring the write but not the audit - which would be
 * invisible, since the services treat both repositories as optional and silently record nothing
 * when they are absent (see LakeConfigAuditAdapters). Deliberately states no route COUNT: every
 * audited write path spreads this, and a hand-maintained tally here went stale by five without
 * anyone noticing.
 *
 * `adminSettings` is here because it is what makes the retention lever provably READ on the path
 * it governs, per the epic's levers rule. Omitting it would still produce events, just always at
 * the floor default, which is the failure mode a lever with no consumer has.
 *
 * Spread it into a service's `db`, e.g.
 *   db: { dataLakes: dataLakeRepository, ...lakeConfigAuditDb }
 *
 * Frozen: it is module-level shared state spread into every audited write path, so a stray
 * mutation anywhere would silently repoint the audit for all of them at once.
 */
export const lakeConfigAuditDb = Object.freeze({
  lakeConfigChangeEvents: lakeConfigChangeEventRepository,
  adminSettings: adminSettingsRepository,
});
