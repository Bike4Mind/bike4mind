import type { IModelPrice, IModelPriceRepository } from '@bike4mind/common';
import seedFile from './modelPrices.seed.json';
import type { ModelPriceSeedEntry } from './generateModelPriceSeed';

const FAR_FUTURE = new Date('9999-01-01T00:00:00Z');

/** Note marking rows this seeder wrote. Rows with any other note are operator
 * reprices and are never superseded by seeding. */
export const SEED_NOTE = 'adapter-seed';

export interface ModelPriceSeedFile {
  /** Generation timestamp, stamped by the regeneration script. Doubles as the
   * deterministic effectiveFrom for every row of this seed version, so
   * concurrent seeders collide on the unique index instead of duplicating. */
  generatedAt: string;
  entries: ModelPriceSeedEntry[];
}

/** Rate fields compared for price equality. Must cover every ModelPriceTier
 * field, or a reprice touching only the missing one never propagates. */
const TIER_RATE_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'audio_input',
  'audio_cache_read',
  'audio_output',
] as const;

/** Stable serialization for price equality (key order normalized). */
function normalizePricing(pricing: ModelPriceSeedEntry['pricing'] | IModelPrice['pricing']): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(pricing).sort()) {
    const tier = pricing[key] as Record<string, number | undefined>;
    const normalized: Record<string, number> = {};
    for (const field of TIER_RATE_FIELDS) {
      if (tier[field] !== undefined) normalized[field] = tier[field];
    }
    out[key] = normalized;
  }
  return JSON.stringify(out);
}

/**
 * Seed the price catalog from the checked-in, PR-reviewed seed file.
 * Per entry, against the newest existing row for (modelId, unit):
 *
 * - no row            -> append at the seed version's effectiveFrom
 * - operator row      -> skip (operator reprices always win over seeding)
 * - adapter-seed row at/after this seed version -> skip (already current)
 * - adapter-seed row older with DIFFERENT pricing -> append (this is how a
 *   corrected adapter literal reaches an existing deployment on next boot)
 * - adapter-seed row older with the same pricing  -> skip
 *
 * effectiveFrom defaults to the seed file's generatedAt (deterministic:
 * concurrent Lambda cold starts write the same triple and the unique index
 * makes the race a no-op). Append-only throughout; safe on every boot.
 */
export async function seedModelPrices(
  repository: IModelPriceRepository,
  options: { effectiveFrom?: Date } = {}
): Promise<{ inserted: number; skipped: number }> {
  // JSON import infers a literal union per entry; widen through unknown.
  const seed = seedFile as unknown as ModelPriceSeedFile;
  const effectiveFrom = options.effectiveFrom ?? new Date(seed.generatedAt);

  // rowsInForce at far-future resolves the newest row per (modelId, unit).
  const existing = await repository.rowsInForce(FAR_FUTURE);
  const newest = new Map(existing.map(row => [`${row.modelId}|${row.unit}`, row]));

  let inserted = 0;
  let skipped = 0;
  for (const entry of seed.entries) {
    const current = newest.get(`${entry.modelId}|${entry.unit}`);
    if (current) {
      const isSeedRow = current.note === SEED_NOTE;
      const alreadyCurrent = current.effectiveFrom.getTime() >= effectiveFrom.getTime();
      const samePrice = normalizePricing(current.pricing) === normalizePricing(entry.pricing);
      const sameVersion = current.effectiveFrom.getTime() === effectiveFrom.getTime();
      if (isSeedRow && sameVersion && !samePrice) {
        // Entries were edited without bumping generatedAt: the change cannot
        // be versioned (equal effectiveFrom collides on the unique index), so
        // deployments keep billing from the stale row. Be loud about it.
        // Strict equality only: a strictly newer row just means an older-code
        // instance is booting after a newer seed landed (rollback / canary).
        console.warn(
          `[modelPriceCatalog] seed entry for ${entry.modelId} (${entry.unit}) differs from the newest seed row but generatedAt (${seed.generatedAt}) was not bumped; ` +
            'regenerate the seed instead of editing entries: pnpm --filter @bike4mind/database generate:model-price-seed'
        );
      }
      if (!isSeedRow || alreadyCurrent || samePrice) {
        skipped += 1;
        continue;
      }
    }
    try {
      await repository.append({
        modelId: entry.modelId,
        unit: entry.unit,
        pricing: entry.pricing,
        effectiveFrom,
        note: SEED_NOTE,
      });
      inserted += 1;
    } catch (error) {
      // E11000: a concurrent seeder won the race on the unique index.
      if ((error as { code?: number }).code === 11000) {
        skipped += 1;
      } else {
        throw error;
      }
    }
  }
  return { inserted, skipped };
}
