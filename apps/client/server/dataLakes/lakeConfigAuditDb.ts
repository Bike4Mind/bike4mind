import { adminSettingsRepository, lakeConfigChangeEventRepository } from '@bike4mind/database';

/**
 * The audit half of every lake CONFIG-write service's `db` adapters, in one place so the four
 * routes that drive those services cannot drift into wiring three of them and forgetting the
 * fourth - which would be invisible, since the services treat both repositories as optional and
 * silently record nothing when they are absent (see LakeConfigAuditAdapters).
 *
 * `adminSettings` is here because it is what makes the retention lever provably READ on the path
 * it governs, per the epic's levers rule. Omitting it would still produce events, just always at
 * the floor default, which is the failure mode a lever with no consumer has.
 *
 * Spread it into a service's `db`, e.g.
 *   db: { dataLakes: dataLakeRepository, ...lakeConfigAuditDb }
 */
export const lakeConfigAuditDb = {
  lakeConfigChangeEvents: lakeConfigChangeEventRepository,
  adminSettings: adminSettingsRepository,
};
