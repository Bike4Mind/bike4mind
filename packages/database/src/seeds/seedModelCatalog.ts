import type { IModelCatalogRepository, IModelCatalogRow } from '@bike4mind/common';
import seedFile from './modelCatalog.seed.json';
import type { ModelCatalogSeedEntry } from './generateModelCatalogSeed';

const FAR_FUTURE = new Date('9999-01-01T00:00:00Z');

/** Source marking rows this seeder wrote. */
export const CATALOG_SEED_SOURCE = 'seed';

/** Provenance detail on a seeded row, mirroring the price seed's SEED_NOTE. */
export const CATALOG_SEED_NOTE = 'adapter-seed';

/** Source marking rows a discovery run wrote; see provenanceOf. */
const CATALOG_DISCOVERY_SOURCE = 'discovery';

/** Which tier owns the newest row, which is what decides whether a seed may
 * supersede it. Anything unrecognized is an operator row: seeding may only
 * overwrite provenance it can positively identify. Mirrors provenanceOf in
 * seedModelPrices.ts, which the catalog tiers deliberately match. */
function provenanceOf(row: IModelCatalogRow): 'seed' | 'automation' | 'operator' {
  if (row.source === CATALOG_SEED_SOURCE) return 'seed';
  if (row.source === CATALOG_DISCOVERY_SOURCE) return 'automation';
  return 'operator';
}

export interface ModelCatalogSeedFile {
  /** Generation timestamp, stamped by the regeneration script. Doubles as the
   * deterministic effectiveFrom for every row of this seed version, so
   * concurrent seeders collide on the unique index instead of duplicating. */
  generatedAt: string;
  /** The "Fallback defaults last maintained on <date>" notice; see buildSeedNotice. */
  notice: string;
  entries: ModelCatalogSeedEntry[];
}

/** Stable serialization for row equality: key order and group order normalized. */
function normalizeRow(patch: unknown, ownedGroups: readonly string[]): string {
  return stableStringify({ patch, ownedGroups: [...ownedGroups].sort() });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Seed the model catalog from the checked-in, PR-reviewed seed file.
 *
 * Three provenance tiers, operator > discovery > adapter-seed. Per entry,
 * against the newest existing row for the model:
 *
 * - no row                                       -> append at the seed version's effectiveFrom
 * - operator row                                 -> skip, always (an operator edit is immune)
 * - seed or discovery row at/after this seed version -> skip (already current)
 * - seed or discovery row older with DIFFERENT content -> append (this is how a
 *   corrected adapter table reaches an existing deployment on next boot)
 * - either, older, with the same content         -> skip
 * - concurrent writer won the unique index       -> skip (append returns null on E11000)
 *
 * Superseding an OLDER discovery row mirrors seedModelPrices: without it a
 * single automated row would freeze seed corrections for that model forever,
 * fixable only by hand. One limit worth knowing: merge-time precedence still
 * ranks discovery above seed per FIELD GROUP (mergeCatalog.outranks), so the
 * appended row only takes effect for the groups the discovery row does not own.
 * Correcting a group discovery owns remains an operator patch, deliberately -
 * recency beating rank at merge time would let any stale discovery row shadow
 * operator intent.
 *
 * effectiveFrom defaults to the seed file's generatedAt (deterministic:
 * concurrent cold starts write the same pair and the unique index makes the race
 * a no-op). Append-only throughout; safe on every boot.
 */
export async function seedModelCatalog(
  repository: IModelCatalogRepository,
  options: { effectiveFrom?: Date } = {}
): Promise<{ inserted: number; skipped: number }> {
  // JSON import infers a literal union per entry; widen through unknown.
  const seed = seedFile as unknown as ModelCatalogSeedFile;
  const effectiveFrom = options.effectiveFrom ?? new Date(seed.generatedAt);

  // rowsInForce returns several rows per model (per-group precedence needs them
  // all) newest first, so the first row for a modelId is that model's newest.
  const existing = await repository.rowsInForce(FAR_FUTURE);
  const newest = new Map<string, IModelCatalogRow>();
  for (const row of existing) {
    if (!newest.has(row.modelId)) newest.set(row.modelId, row);
  }

  let inserted = 0;
  let skipped = 0;
  for (const entry of seed.entries) {
    const current = newest.get(entry.modelId);
    if (current) {
      const provenance = provenanceOf(current);
      const alreadyCurrent = current.effectiveFrom.getTime() >= effectiveFrom.getTime();
      const sameRow = normalizeRow(current.patch, current.ownedGroups) === normalizeRow(entry.patch, entry.ownedGroups);
      const sameVersion = current.effectiveFrom.getTime() === effectiveFrom.getTime();
      if (provenance === 'seed' && sameVersion && !sameRow) {
        // Entries were edited without bumping generatedAt: the change cannot be
        // versioned (equal effectiveFrom collides on the unique index), so
        // deployments keep the stale row. Be loud about it. Strict equality
        // only: a strictly newer row just means an older-code instance is
        // booting after a newer seed landed (rollback / canary).
        console.warn(
          `[modelCatalog] seed entry for ${entry.modelId} differs from the newest seed row but generatedAt (${seed.generatedAt}) was not bumped; ` +
            'regenerate the seed instead of editing entries: pnpm --filter @bike4mind/database generate:model-catalog-seed'
        );
      }
      if (provenance === 'operator' || alreadyCurrent || sameRow) {
        skipped += 1;
        continue;
      }
    }
    const appended = await repository.append({
      modelId: entry.modelId,
      source: 'seed',
      patch: entry.patch,
      ownedGroups: entry.ownedGroups,
      effectiveFrom,
      note: CATALOG_SEED_NOTE,
    });
    if (appended) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}
