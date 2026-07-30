import {
  DISCOVERY_PRICE_NOTE_PREFIX,
  type IModelPrice,
  type IModelPriceInput,
  type IModelPriceTier,
} from '@bike4mind/common';
import isEqual from 'lodash/isEqual.js';
import { PRICE_AGREEMENT_TOLERANCE, relativeGap } from './catalogWrite';
import type {
  DiscoveredPrice,
  DiscoverySourceKind,
  PlannedPriceRow,
  PriceFlag,
  PriceFlagKind,
  PriceSkip,
  PriceSkipReason,
  SourceContribution,
} from './types';

/**
 * ModelPrice tier rates are USD per SINGLE token and DiscoveredPrice is USD per
 * 1M tokens. Every crossing of that boundary goes through this constant; a
 * missed division is a 1e6 overcharge, which is why nothing here multiplies
 * inline. (litellm.ts carries its own copy for parsing its feed - that one
 * converts the other way and has nothing to do with what we persist.)
 */
const TOKENS_PER_MTOK = 1_000_000;

/**
 * The seeder's note. MUST STAY IN SYNC WITH SEED_NOTE in
 * packages/database/src/seeds/seedModelPrices.ts, which the service layer
 * cannot import. Getting it wrong reclassifies every seeded row as operator-
 * owned, which fails closed (discovery writes less) rather than open.
 */
export const SEED_PRICE_NOTE = 'adapter-seed';

/** Stamped on every row discovery appends, for the admin provenance badge. */
export const DISCOVERY_REPRICED_BY = 'model-discovery';

/**
 * Rate fields compared for tier equality. MUST COVER every ModelPriceTier
 * field (same reason as TIER_RATE_FIELDS in seedModelPrices.ts): a field left
 * out here compares as "unchanged" and its correction never versions.
 */
const TIER_RATE_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'audio_input',
  'audio_cache_read',
  'audio_output',
] as const;

/** Audio rates no feed publishes; they only ever survive by being carried forward. */
const AUDIO_RATE_FIELDS = ['audio_input', 'audio_cache_read', 'audio_output'] as const;

/**
 * Every rate a feed can publish, paired with the tier field it lands in. The
 * agreement check, the band and the write all walk this list, so a cache rate
 * cannot reach a row through a guardrail that only knew about input and output.
 */
const OBSERVED_RATES = [
  ['inputPerMTok', 'input'],
  ['outputPerMTok', 'output'],
  ['cacheReadPerMTok', 'cache_read'],
  ['cacheWritePerMTok', 'cache_write'],
] as const;

/**
 * Who owns the row in force. Anything unrecognized, a missing note included, is
 * an operator row: automation may only supersede what it can prove it wrote.
 */
export type PriceRowProvenance = 'seed' | 'automation' | 'operator';

export function classifyPriceRow(row: Pick<IModelPrice, 'note'>): PriceRowProvenance {
  if (row.note === SEED_PRICE_NOTE) return 'seed';
  if (row.note?.startsWith(DISCOVERY_PRICE_NOTE_PREFIX)) return 'automation';
  return 'operator';
}

interface PriceObservation {
  source: string;
  kind: DiscoverySourceKind;
  price: DiscoveredPrice;
}

export interface PricePlanInput {
  /** This run's successful sources, exactly as planCatalogWrites takes them. */
  contributions: readonly SourceContribution[];
  /** Price rows in force as of this pass; only per_token rows are considered. */
  rowsInForce: readonly IModelPrice[];
  /**
   * Price rows in force when the RUN started, which is what the band measures
   * against. A run makes several passes and re-reads `rowsInForce` at each one,
   * so banding against the previous pass would let a drifting feed stack a band
   * per pass (1.4x three times is 2.74x under a 50% band). Unset means a
   * single-pass run, where the two reads are the same rows.
   */
  baselineRowsInForce?: readonly IModelPrice[];
  /** Ids the catalog covers, including the models this run's catalog plan adds. */
  knownModelIds: ReadonlySet<string>;
  /** modelDiscoveryPriceBandPct: the largest move, in percent, applied unattended. */
  bandPct: number;
  runStartedAt: Date;
}

export interface PricePlan {
  rows: IModelPriceInput[];
  flags: PriceFlag[];
  /** Usable observations that produced neither a row nor a flag, and why. */
  skipped: PriceSkip[];
}

/**
 * Turn this run's observed prices into the ModelPrice rows it would append.
 *
 * Every precedence rule is enforced HERE, at write time, because the runtime
 * read path (applyModelPriceCatalog) has no provenance awareness at all: it
 * takes whichever per_token row has the latest effectiveFrom. A row this
 * planner should not have written is a row that silently reprices production.
 *
 * Diff-based like planCatalogWrites: an unchanged tier produces nothing, so a
 * second run over identical source data appends zero rows.
 */
export function planPriceWrites(input: PricePlanInput): PricePlan {
  const observed = collectObservations(input.contributions);
  const perTokenRows = (rows: readonly IModelPrice[]) =>
    new Map(rows.filter(row => row.unit === 'per_token').map(row => [row.modelId, row] as const));
  const inForce = perTokenRows(input.rowsInForce);
  const atRunStart = input.baselineRowsInForce ? perTokenRows(input.baselineRowsInForce) : inForce;

  const rows: IModelPriceInput[] = [];
  const flags: PriceFlag[] = [];
  const skipped: PriceSkip[] = [];
  const skip = (modelId: string, reason: PriceSkipReason) => skipped.push({ modelId, reason });

  for (const modelId of [...observed.keys()].sort()) {
    const observations = observed.get(modelId) ?? [];
    const sources = observations.map(observation => observation.source);

    // An id no catalog row covers cannot be priced: ModelPrice.append has no
    // unknown-model check of its own, so a mis-joined aggregator key would
    // otherwise create a price for a model nobody can call (sec 8).
    if (!input.knownModelIds.has(modelId)) {
      skip(modelId, 'unknown-model');
      continue;
    }

    const disagreeing = firstDisagreement(observations);
    if (disagreeing) {
      flags.push({
        modelId,
        kind: 'source-disagreement',
        // One of the two sides the detail names: a third source's value would be
        // a number the operator cannot find anywhere in the sentence.
        proposed: perMTokOf(disagreeing[0].price),
        sources,
        detail:
          `sources disagree beyond ${pct(PRICE_AGREEMENT_TOLERANCE)}: ` +
          `${disagreeing[0].source} ${describe(disagreeing[0].price)} vs ${disagreeing[1].source} ` +
          `${describe(disagreeing[1].price)}; applied neither`,
      });
      continue;
    }

    const current = inForce.get(modelId);
    const currentEntry = current ? lowestTierEntry(current) : undefined;
    const currentTier = currentEntry?.[1];
    const currentPrice = currentTier ? perMTokOf(tierAsPrice(currentTier)) : undefined;
    const flag = (kind: PriceFlagKind, price: DiscoveredPrice, detail: string) =>
      flags.push({ modelId, kind, proposed: perMTokOf(price), current: currentPrice, sources, detail });

    const provider = observations.find(observation => observation.kind === 'provider');
    const aggregators = observations.filter(observation => observation.kind === 'aggregator');

    // A lone aggregator is corroboration-free, so it never writes. It is worth
    // an operator's attention only when it contradicts what we already bill.
    if (!provider && aggregators.length < 2) {
      const lone = aggregators[0];
      if (!currentTier) {
        flag(
          'single-source-untrusted',
          lone.price,
          `${lone.source} is the only source pricing this unpriced model at ${describe(lone.price)}; ` +
            'a second source or an operator has to confirm it'
        );
      } else if (diverges(lone.price, tierAsPrice(currentTier), PRICE_AGREEMENT_TOLERANCE)) {
        flag(
          'single-source-untrusted',
          lone.price,
          `${lone.source} alone prices this at ${describe(lone.price)} against the row in force ` +
            `${describe(tierAsPrice(currentTier))}; one aggregator is not enough to reprice`
        );
      } else {
        skip(modelId, 'untrusted');
      }
      continue;
    }

    // Trusted: a provider's own API, or aggregators that already passed the
    // agreement check above. The provider value wins; models.dev leads the
    // aggregators by registration order, not by name.
    const trusted = provider ?? aggregators[0];
    const valueSources = provider ? [provider.source] : aggregators.map(observation => observation.source);
    const proposed = trusted.price;

    if (current && classifyPriceRow(current) === 'operator') {
      if (currentTier && diverges(proposed, tierAsPrice(currentTier), PRICE_AGREEMENT_TOLERANCE)) {
        flag(
          'operator-owned-divergence',
          proposed,
          `the operator row ${describe(tierAsPrice(currentTier))} differs from ${valueSources.join('+')} ` +
            `${describe(proposed)}; only an operator can change it`
        );
      } else {
        skip(modelId, 'operator-owned');
      }
      continue;
    }

    // A single observed rate cannot express a tier ladder, and the read path
    // REPLACES the whole pricing map, so writing one would delete the ladder.
    if (current && isTiered(current)) {
      if (currentTier && diverges(proposed, tierAsPrice(currentTier), PRICE_AGREEMENT_TOLERANCE)) {
        flag(
          'tiered-pricing-manual',
          proposed,
          `the row in force is tiered (${Object.keys(current.pricing).sort().join(', ')}) and its lowest tier ` +
            `${describe(tierAsPrice(currentTier))} differs from ${valueSources.join('+')} ${describe(proposed)}; ` +
            'repricing a tier ladder is a manual edit'
        );
      } else {
        skip(modelId, 'tiered-pricing');
      }
      continue;
    }

    // Measured against the run's opening position, not the row the previous pass
    // of this same run wrote: the band is what one unattended run may move a
    // price by, and a per-pass measurement would multiply it by the pass count.
    // A model unpriced at run start falls back to the row in force, which is one
    // this run wrote - its first write had nothing to band against either.
    const openingRow = atRunStart.get(modelId);
    const bandBaseline = (openingRow ? lowestTier(openingRow) : undefined) ?? currentTier;
    if (bandBaseline) {
      const band = input.bandPct / 100;
      const moves = bandMoves(proposed, bandBaseline);
      if (moves.some(move => move.move > band)) {
        flag(
          'band-exceeded',
          proposed,
          `${valueSources.join('+')} moves ${moves.map(move => `${move.rate} ${pct(move.move)}`).join(', ')} against ` +
            `the row this run started from (band ${pct(band)}): ${describe(tierAsPrice(bandBaseline))} -> ` +
            `${describe(proposed)}`
        );
        continue;
      }
    }

    const tier = buildTier(proposed, currentTier);
    if (currentTier && isEqual(rateFields(tier), rateFields(currentTier))) {
      skip(modelId, 'unchanged');
      continue;
    }

    rows.push({
      modelId,
      unit: 'per_token',
      // Keyed like the row it supersedes: the seed keys its single tier at the
      // model's context window, and re-keying it to '0' would churn a threshold
      // convention this planner has no way to re-derive.
      pricing: { [currentEntry?.[0] ?? '0']: tier },
      effectiveFrom: input.runStartedAt,
      note: `${DISCOVERY_PRICE_NOTE_PREFIX}${valueSources.join('+')}@${input.runStartedAt.toISOString()}`,
      repricedBy: DISCOVERY_REPRICED_BY,
    });
  }

  return { rows, flags, skipped };
}

/** One model's comparable cost: the lowest tier's rates, in USD per single token. */
export interface PerTokenRates {
  input: number;
  output: number;
}

/**
 * The per-token rates in force, by model. The auto-remap cost constraint
 * compares two models against each other rather than against a published rate,
 * so the stored unit is the right one and there is no 1e6 crossing to get wrong.
 */
export function perTokenRatesInForce(rows: readonly IModelPrice[]): Map<string, PerTokenRates> {
  const rates = new Map<string, PerTokenRates>();
  for (const row of rows) {
    if (row.unit !== 'per_token') continue;
    const tier = lowestTier(row);
    if (tier) rates.set(row.modelId, { input: tier.input, output: tier.output });
  }
  return rates;
}

/** The planned rows as the run report shows them: per-MTok, no tier map. */
export function describePriceRows(rows: readonly IModelPriceInput[]): PlannedPriceRow[] {
  return rows.map(row => {
    // Read off the tier, not the key: a planned row is keyed like the row it
    // supersedes, which is rarely '0'.
    const tier = lowestTierEntry(row)?.[1] ?? { input: 0, output: 0 };
    return {
      modelId: row.modelId,
      unit: row.unit,
      inputPerMTok: tier.input * TOKENS_PER_MTOK,
      outputPerMTok: tier.output * TOKENS_PER_MTOK,
      effectiveFrom: row.effectiveFrom,
      sources: sourcesOfNote(row.note),
      note: row.note ?? '',
    };
  });
}

/**
 * Usable observations per model, providers first and registration order within
 * a kind - the same precedence collectCandidates applies to fields, decided the
 * same way so a price and the record it prices never credit different sources.
 */
function collectObservations(contributions: readonly SourceContribution[]): Map<string, PriceObservation[]> {
  const ordered = [...contributions].sort((a, b) => (a.kind === 'provider' ? 0 : 1) - (b.kind === 'provider' ? 0 : 1));
  const observed = new Map<string, PriceObservation[]>();

  for (const contribution of ordered) {
    for (const record of contribution.records) {
      const modelId = typeof record?.modelId === 'string' ? record.modelId.trim() : '';
      if (!modelId || !record.pricing || !isUsable(record.pricing)) continue;
      const existing = observed.get(modelId);
      const observation = {
        source: contribution.name,
        kind: contribution.kind,
        price: withUsableCacheRates(record.pricing),
      };
      if (existing) existing.push(observation);
      else observed.set(modelId, [observation]);
    }
  }
  return observed;
}

/**
 * An all-zero observation is freeToRun territory, never a price row: append
 * rejects it anyway, and a model that genuinely costs nothing is a catalog
 * flag, not a $0 row that would settle every call free.
 */
function isUsable(price: DiscoveredPrice): boolean {
  const rates = [price.inputPerMTok, price.outputPerMTok];
  if (!rates.every(rate => Number.isFinite(rate) && rate >= 0)) return false;
  return rates.some(rate => rate > 0);
}

/**
 * The observation as every guardrail below reads it: a cache rate published as 0
 * is dropped, so it neither disagrees, nor bands, nor writes, and the rate in
 * force is carried forward instead. Zero is a claim no feed gets to make - see
 * perToken for what a stored 0 would do to settlement.
 */
function withUsableCacheRates(price: DiscoveredPrice): DiscoveredPrice {
  const usable: DiscoveredPrice = { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
  const cacheRead = positiveRate(price.cacheReadPerMTok);
  const cacheWrite = positiveRate(price.cacheWritePerMTok);
  if (cacheRead !== undefined) usable.cacheReadPerMTok = cacheRead;
  if (cacheWrite !== undefined) usable.cacheWritePerMTok = cacheWrite;
  return usable;
}

/** The first pair that disagrees, so the flag can name both sides. */
function firstDisagreement(observations: readonly PriceObservation[]): [PriceObservation, PriceObservation] | null {
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      if (diverges(observations[i].price, observations[j].price, PRICE_AGREEMENT_TOLERANCE)) {
        return [observations[i], observations[j]];
      }
    }
  }
  return null;
}

/**
 * Disagreement over any rate BOTH sides publish. A rate only one of them carries
 * is silence rather than a contradiction: models.dev quoting cache_read where
 * litellm does not is the ordinary case and may not read as a conflict.
 */
function diverges(a: DiscoveredPrice, b: DiscoveredPrice, tolerance: number): boolean {
  return OBSERVED_RATES.some(([rate]) => {
    const left = a[rate];
    const right = b[rate];
    return left !== undefined && right !== undefined && relativeGap(left, right) > tolerance;
  });
}

/**
 * The row's cheapest-threshold tier and the key it sits under, the only tier a
 * single observed rate could correspond to. Used for the flag comparisons, for
 * carrying forward the rates no feed publishes, and for keying the row that
 * supersedes this one.
 */
function lowestTierEntry(row: Pick<IModelPrice, 'pricing'>): [string, IModelPriceTier] | undefined {
  const [threshold] = Object.keys(row.pricing).sort((a, b) => Number(a) - Number(b));
  return threshold === undefined ? undefined : [threshold, row.pricing[threshold]];
}

const lowestTier = (row: Pick<IModelPrice, 'pricing'>): IModelPriceTier | undefined => lowestTierEntry(row)?.[1];

/**
 * A ladder discovery must not flatten: more than one threshold. A single tier is
 * flat whatever key it carries - the seed keys its one tier at the model's
 * context window, so reading '0' as the only flat shape would freeze nearly
 * every seeded row. An empty map counts as a ladder, which fails closed.
 */
const isTiered = (row: IModelPrice): boolean => Object.keys(row.pricing).length !== 1;

/**
 * Every rate the band applies to: the two text rates, plus a cache rate when the
 * row in force carries it AND this observation quotes it. Each move is measured
 * against the CURRENT rate rather than symmetrically, so the setting reads as a
 * multiple of what we bill today (200% is "up to 3x") instead of saturating at
 * 100%, where relativeGap would silently disable the band.
 */
function bandMoves(proposed: DiscoveredPrice, current: IModelPriceTier): Array<{ rate: string; move: number }> {
  const moves: Array<{ rate: string; move: number }> = [];
  for (const [observed, field] of OBSERVED_RATES) {
    const next = proposed[observed];
    const held = current[field];
    if (next === undefined || held === undefined) continue;
    moves.push({ rate: field, move: baselineMove(next, held * TOKENS_PER_MTOK) });
  }
  return moves;
}

/** Leaving a zero rate for a real one exceeds any band: nothing is a multiple of 0. */
const baselineMove = (proposed: number, current: number): number => {
  if (proposed === current) return 0;
  return current === 0 ? Number.POSITIVE_INFINITY : Math.abs(proposed - current) / current;
};

/**
 * The tier a row would carry. Cache and audio rates the feed does not publish
 * are carried forward from the row being superseded: dropping them would
 * silently move cached reads and voice minutes onto the text rate, which is a
 * billing change nobody asked for.
 */
function buildTier(price: DiscoveredPrice, carry: IModelPriceTier | undefined): IModelPriceTier {
  const tier: IModelPriceTier = {
    input: price.inputPerMTok / TOKENS_PER_MTOK,
    output: price.outputPerMTok / TOKENS_PER_MTOK,
  };
  const cacheRead = perToken(price.cacheReadPerMTok) ?? carry?.cache_read;
  const cacheWrite = perToken(price.cacheWritePerMTok) ?? carry?.cache_write;
  if (cacheRead !== undefined) tier.cache_read = cacheRead;
  if (cacheWrite !== undefined) tier.cache_write = cacheWrite;
  for (const field of AUDIO_RATE_FIELDS) {
    const rate = carry?.[field];
    if (rate !== undefined) tier[field] = rate;
  }
  return tier;
}

/**
 * Per single token, with a rate of 0 read as UNPUBLISHED rather than free:
 * getTextModelCost falls back to input * CACHE_READ_MULTIPLIER only while
 * cache_read is ABSENT, so a stored 0 would settle every cached read at nothing.
 */
const perToken = (perMTok: number | undefined): number | undefined => {
  const rate = positiveRate(perMTok);
  return rate === undefined ? undefined : rate / TOKENS_PER_MTOK;
};

const positiveRate = (rate: number | undefined): number | undefined =>
  rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : undefined;

/** Only the declared rates, so a stored row's extra keys cannot read as a change. */
function rateFields(tier: IModelPriceTier): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of TIER_RATE_FIELDS) {
    const rate = tier[field];
    if (rate !== undefined) out[field] = rate;
  }
  return out;
}

const tierAsPrice = (tier: IModelPriceTier): DiscoveredPrice => {
  const price: DiscoveredPrice = {
    inputPerMTok: tier.input * TOKENS_PER_MTOK,
    outputPerMTok: tier.output * TOKENS_PER_MTOK,
  };
  if (tier.cache_read !== undefined) price.cacheReadPerMTok = tier.cache_read * TOKENS_PER_MTOK;
  if (tier.cache_write !== undefined) price.cacheWritePerMTok = tier.cache_write * TOKENS_PER_MTOK;
  return price;
};

/** Trims the float noise a 1e6 round trip leaves, which no report should show. */
const perMTokOf = (price: DiscoveredPrice): { inputPerMTok: number; outputPerMTok: number } => ({
  inputPerMTok: readable(price.inputPerMTok),
  outputPerMTok: readable(price.outputPerMTok),
});

const readable = (rate: number): number => Number(rate.toPrecision(10));

/**
 * Every rate the observation carries, cache rates included: a disagreement can
 * live entirely in cache_read, and a detail line that only prints input and
 * output would then show two identical prices "disagreeing" - the opposite of
 * the explainable-line-by-line contract the flags exist to meet.
 */
const describe = (price: DiscoveredPrice): string => {
  const parts = [`in ${readable(price.inputPerMTok)}`, `out ${readable(price.outputPerMTok)}`];
  if (price.cacheReadPerMTok !== undefined) parts.push(`cache_read ${readable(price.cacheReadPerMTok)}`);
  if (price.cacheWritePerMTok !== undefined) parts.push(`cache_write ${readable(price.cacheWritePerMTok)}`);
  return `${parts.join('/')} $/MTok`;
};

/** A move off a zero rate has no percentage; every other fraction is one. */
const pct = (fraction: number): string => (Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : 'unbounded');

/** 'discovery:<sources>@<iso>' back to its source list, for the run report. */
function sourcesOfNote(note: string | undefined): string[] {
  if (!note?.startsWith(DISCOVERY_PRICE_NOTE_PREFIX)) return [];
  const body = note.slice(DISCOVERY_PRICE_NOTE_PREFIX.length);
  const at = body.lastIndexOf('@');
  return (at === -1 ? body : body.slice(0, at)).split('+').filter(Boolean);
}
