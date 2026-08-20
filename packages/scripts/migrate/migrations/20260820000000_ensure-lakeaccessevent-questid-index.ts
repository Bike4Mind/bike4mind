import { LakeAccessEventModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ questId: 1 }` (sparse) exists on lakeaccessevents.
 *
 * `LakeAccessEventModel.ts` now records the Quest id a retrieval-audit row happened during, so a
 * future reader can join "which audit rows back this turn's retrieval" - see the schema field's
 * own doc comment for why this is a diagnostic join key, never authorization data. Declared on the
 * schema too, but relying on autoIndex alone would build it lazily on a cold boot of whichever
 * Lambda touches the collection first - a request-path index on a collection this size belongs in
 * a migration, same rationale as 20260728000000_ensure-fabfilechunk-keyset-index and
 * 20260813000001_ensure-organization-member-index.
 *
 * sparse, not a plain index: most rows have no questId (rows written before this field existed,
 * the quest-less HTTP data-lake routes, an agent-mode row whose execution has not yet linked a
 * Quest id) - a sparse index indexes only the linked ones. Options can't be changed after the
 * fact without a coordinated drop-and-rebuild (see 20260731100000_fix-systemprompt-live-unique-
 * index for exactly that kind of migration), so this is decided now rather than left for later.
 *
 * No createdAt companion, unlike this collection's other three indexes (principalKind+principalId,
 * resolvedLakeIds, organizationId): cardinality per questId is single-digit by construction (at
 * most one row per tool call, one call per surface per turn), unlike those three which can span
 * thousands of rows over the 450-day retention window - an in-memory sort after this index scan
 * is negligible.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260820000000,
  name: 'ensure lakeaccessevent questid index',

  up: async () => {
    await LakeAccessEventModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
