import { DISCOVERY_PRICE_NOTE_PREFIX, type IModelPrice, type IModelPriceRepository } from '@bike4mind/common';
import seedFile from './modelPrices.seed.json';
import type { ModelPriceSeedEntry } from './generateModelPriceSeed';

const FAR_FUTURE = new Date('9999-01-01T00:00:00Z');

/** Note marking rows this seeder wrote. Mirrored as SEED_PRICE_NOTE in
 * b4m-core/services modelDiscoveryService/pricePlan.ts, which cannot import
 * this package; the two must stay in sync. */
export const SEED_NOTE = 'adapter-seed';

/** Which tier owns the newest row, which is what decides whether a seed may
 * supersede it. Anything unrecognized (a missing note included) is an operator
 * row: seeding may only overwrite provenance it can positively identify. */
function provenanceOf(row: IModelPrice): 'seed' | 'automation' | 'operator' {
  if (row.note === SEED_NOTE) return 'seed';
  if (row.note?.startsWith(DISCOVERY_PRICE_NOTE_PREFIX)) return 'automation';
  return 'operator';
}

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
 *
 * Three provenance tiers, operator > discovery > adapter-seed. Per entry,
 * against the newest existing row for (modelId, unit):
 *
 * - no row                                       -> append at the seed version's effectiveFrom
 * - operator row                                 -> skip, always (an operator reprice is immune)
 * - adapter-seed or discovery:* row at/after this seed version -> skip (already current)
 * - adapter-seed or discovery:* row older with DIFFERENT pricing -> append
 * - either, older, with the same pricing         -> skip
 *
 * A seed superseding an OLDER `discovery:*` row is the point: without it one
 * bad automated price would freeze seed corrections for that model forever,
 * fixable only by hand. Discovery gets stickiness against itself, never
 * against a newer human-reviewed seed.
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
      const provenance = provenanceOf(current);
      const alreadyCurrent = current.effectiveFrom.getTime() >= effectiveFrom.getTime();
      const samePrice = normalizePricing(current.pricing) === normalizePricing(entry.pricing);
      const sameVersion = current.effectiveFrom.getTime() === effectiveFrom.getTime();
      if (provenance === 'seed' && sameVersion && !samePrice) {
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
      if (provenance === 'operator' || alreadyCurrent || samePrice) {
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
