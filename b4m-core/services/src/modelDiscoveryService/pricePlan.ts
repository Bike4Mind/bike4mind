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
  DiscoveredPriceBracket,
  DiscoveredRates,
  DiscoverySourceKind,
  PlannedPriceRow,
  PriceFlag,
  PriceFlagKind,
  PriceOverride,
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
  /**
   * Models whose price came from a provider over a mirror that disagreed. One
   * per model, and NOT a subset of `rows`: the provider's value standing
   * unchanged is the steady state, and the stale mirror is the news either way.
   */
  overrides: PriceOverride[];
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
  const overrides: PriceOverride[] = [];
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

    const consensus = reachConsensus(observations);
    if (consensus.kind === 'conflict') {
      flags.push({
        modelId,
        kind: 'source-disagreement',
        // One of the two sides the detail names: a third source's value would be
        // a number the operator cannot find anywhere in the sentence.
        proposed: perMTokOf(consensus.proposed),
        sources,
        detail: consensus.detail,
      });
      continue;
    }

    const current = inForce.get(modelId);
    const currentThresholds = current ? thresholdsOf(current) : [];
    const currentEntry = current ? lowestTierEntry(current) : undefined;
    const currentTier = currentEntry?.[1];
    const currentPrice = currentTier ? perMTokOf(tierAsPrice(currentTier)) : undefined;
    const flag = (kind: PriceFlagKind, price: DiscoveredPrice, detail: string) =>
      flags.push({ modelId, kind, proposed: perMTokOf(price), current: currentPrice, sources, detail });

    // A lone aggregator is corroboration-free, so it never writes. It is worth
    // an operator's attention only when it contradicts what we already bill.
    if (consensus.kind === 'lone') {
      const lone = consensus.observation;
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

    // Trusted: a provider's own published price, or aggregators that already
    // passed the agreement check above. models.dev leads the aggregators by
    // registration order, not by name.
    const { observation: trusted, valueSources, corroborating, dissenting } = consensus;
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

    // Banded against the run's opening position, not the row the previous pass of
    // this same run wrote: the band is what one unattended run may move a price
    // by, and a per-pass measurement would multiply it by the pass count. A model
    // unpriced at run start falls back to the row in force, which is one this run
    // wrote - its first write had nothing to band against either.
    const bandRow = atRunStart.get(modelId) ?? current;

    // A ladder needs a corroborator that publishes a ladder, not just one that
    // agrees on the short-prompt price. diverges() is deliberately silent when
    // only ONE side carries brackets, so a mirror that went flat would otherwise
    // corroborate the base rates and let the upper bracket be written on a single
    // scrape's word. Checked here rather than in reachConsensus because a flat row
    // in force discards the brackets anyway - refusing there would block writes
    // whose ladder was never going to be used.
    const ladderUncorroborated =
      proposed.brackets !== undefined &&
      current !== undefined &&
      isTiered(current) &&
      corroborating.length > 0 &&
      !corroborating.some(observation => observation.price.brackets !== undefined);
    if (ladderUncorroborated) {
      flag(
        'tiered-pricing-manual',
        proposed,
        `${trusted.source} publishes ${describe(proposed)} but ` +
          `${corroborating.map(observation => observation.source).join(', ')} publish no long-context rates to ` +
          'corroborate its brackets; repricing a tiered row needs a second source that carries the same ladder'
      );
      continue;
    }

    // The read path REPLACES the whole pricing map, so a tiered row may only be
    // superseded by a write that reproduces every tier. That needs a ladder the
    // sources published and this row's own thresholds to map it onto.
    const ladder = current && isTiered(current) ? planLadder(current, proposed, bandRow) : undefined;
    if (ladder && 'blocked' in ladder) {
      if (currentTier && diverges(proposed, tierAsPrice(currentTier), PRICE_AGREEMENT_TOLERANCE)) {
        flag(
          'tiered-pricing-manual',
          proposed,
          `the row in force is tiered (${currentThresholds.join(', ')}) and its lowest tier ` +
            `${describe(tierAsPrice(currentTier))} differs from ${valueSources.join('+')} ${describe(proposed)}; ` +
            `repricing it needs a ladder that maps onto those thresholds, and ${ladder.blocked}`
        );
      } else {
        skip(modelId, 'tiered-pricing');
      }
      continue;
    }

    // A flat row stays flat even when the sources publish a ladder: inventing a
    // second threshold would bill long prompts at a rate nobody signed off on.
    const planned: PlannedTier[] = ladder?.tiers ?? [
      { key: currentEntry?.[0] ?? '0', price: proposed, baseline: bandRow ? lowestTier(bandRow) : undefined },
    ];

    const band = input.bandPct / 100;
    // Per tier, because a ladder whose upper bracket moves 10x while its base
    // holds steady is exactly the move an operator has to see. The rate name
    // carries its threshold only for a ladder, so a flat row reads as it always did.
    const moves = planned.flatMap(tier =>
      tier.baseline ? bandMoves(tier.price, tier.baseline, planned.length > 1 ? tier.key : undefined) : []
    );
    const bandBaseline = baselineAsPrice(planned);
    if (bandBaseline && moves.some(move => move.move > band)) {
      flag(
        'band-exceeded',
        proposed,
        `${valueSources.join('+')} moves ${moves.map(move => `${move.rate} ${pct(move.move)}`).join(', ')} against ` +
          `the row this run started from (band ${pct(band)}): ${describe(bandBaseline)} -> ` +
          `${describe(proposed)}`
      );
      continue;
    }

    // Recorded wherever the provider's value STANDS - both when it is written and
    // when the row in force already says it. Every refusal above is reported as
    // its own flag, so this cannot double-report one; but 'unchanged' is the
    // STEADY STATE once the catalog converges, and that is exactly when "which
    // mirror has gone stale" is the only fact left to learn.
    if (dissenting.length > 0) {
      overrides.push({
        modelId,
        source: trusted.source,
        dissenting: dissenting.map(observation => observation.source),
        applied: perMTokOf(proposed),
        // Present tense, like every flag detail: this planner runs identically in
        // report mode, where nothing is written, so a sentence claiming a write
        // would be false on the default run.
        detail:
          `${trusted.source} publishes ${describe(proposed)} and ` +
          `${dissenting.map(observation => `${observation.source} ${describe(observation.price)}`).join(', ')} ` +
          `disagree beyond ${pct(PRICE_AGREEMENT_TOLERANCE)}; the provider value wins`,
      });
    }

    // Carried forward per tier: the cache and audio rates no feed publishes come
    // from the tier under the SAME threshold, never from the row's lowest one.
    const tiers = planned.map(({ key, price }) => [key, buildTier(price, current?.pricing[key])] as const);
    const unchanged =
      current !== undefined &&
      tiers.every(([key, tier]) => {
        const held = current.pricing[key];
        return held !== undefined && isEqual(rateFields(tier), rateFields(held));
      });
    if (unchanged) {
      skip(modelId, 'unchanged');
      continue;
    }

    rows.push({
      modelId,
      unit: 'per_token',
      // Keyed like the row it supersedes: the seed keys its single tier at the
      // model's context window, and re-keying it to '0' would churn a threshold
      // convention this planner has no way to re-derive.
      pricing: Object.fromEntries(tiers),
      effectiveFrom: input.runStartedAt,
      note: `${DISCOVERY_PRICE_NOTE_PREFIX}${valueSources.join('+')}@${input.runStartedAt.toISOString()}`,
      repricedBy: DISCOVERY_REPRICED_BY,
    });
  }

  return { rows, flags, overrides, skipped };
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
        price: usableObservation(record.pricing),
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
function isUsable(price: DiscoveredRates): boolean {
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
function usableObservation(price: DiscoveredPrice): DiscoveredPrice {
  const usable: DiscoveredPrice = usableRates(price);
  const brackets = usableBrackets(price.brackets);
  if (brackets) usable.brackets = brackets;
  return usable;
}

function usableRates(rates: DiscoveredRates): DiscoveredRates {
  const usable: DiscoveredRates = { inputPerMTok: rates.inputPerMTok, outputPerMTok: rates.outputPerMTok };
  const cacheRead = positiveRate(rates.cacheReadPerMTok);
  const cacheWrite = positiveRate(rates.cacheWritePerMTok);
  if (cacheRead !== undefined) usable.cacheReadPerMTok = cacheRead;
  if (cacheWrite !== undefined) usable.cacheWritePerMTok = cacheWrite;
  return usable;
}

/**
 * The ladder as the guardrails read it, ascending by breakpoint. All or nothing:
 * one unusable bracket drops the whole ladder, because a ladder missing a rung
 * would bill that rung's prompts at the rate below it. A source publishing no
 * usable ladder reads as flat, which is how every source read before ladders
 * existed.
 */
function usableBrackets(brackets: readonly DiscoveredPriceBracket[] | undefined): DiscoveredPriceBracket[] | undefined {
  if (!brackets?.length) return undefined;
  const ascending = [...brackets].sort((a, b) => a.aboveTokens - b.aboveTokens);

  const usable: DiscoveredPriceBracket[] = [];
  for (const bracket of ascending) {
    // A stored tier key is a positive integer, and two rates for one breakpoint is
    // a ladder with no reading to prefer.
    const { aboveTokens } = bracket;
    if (!Number.isInteger(aboveTokens) || aboveTokens <= 0 || !isUsable(bracket)) return undefined;
    if (usable.some(kept => kept.aboveTokens === aboveTokens)) return undefined;
    usable.push({ aboveTokens, ...usableRates(bracket) });
  }
  return usable;
}

/**
 * What this run's sources add up to for one model.
 *
 * 'conflict' carries the sentence rather than the pair, because the two ways to
 * reach it read differently to an operator: mirrors that contradict each other,
 * and mirrors that all contradict the provider.
 */
type Consensus =
  | { kind: 'conflict'; proposed: DiscoveredPrice; detail: string }
  | { kind: 'lone'; observation: PriceObservation }
  | {
      kind: 'trusted';
      observation: PriceObservation;
      /** Credited in the row's note: the sources whose value it is. */
      valueSources: string[];
      /** Aggregators that agree with a provider; empty in every other case. */
      corroborating: PriceObservation[];
      /** Sources overruled by a provider, empty in every other case. */
      dissenting: PriceObservation[];
    };

/**
 * A PROVIDER'S OWN PUBLISHED PRICE IS PRIMARY. WHERE MIRRORS EXIST, one of them
 * has to agree with it - but not all of them, and the ones that disagree are
 * recorded and overruled rather than allowed to veto. A provider no aggregator
 * prices at all still writes alone, which is what it has always done; that is a
 * standing property of a provider source, not something this rule grants.
 *
 * That asymmetry is the whole point. The two aggregators are mirrors of the
 * provider, and a mirror goes stale on its own schedule: litellm publishes from a
 * git ref that lags, models.dev re-scrapes on its own cadence. Requiring all of
 * them to agree hands any one of them a veto over a price the provider itself
 * publishes, which is how an 80% price cut can keep billing at the old rate until
 * the slowest mirror catches up.
 *
 * With no provider price, nothing here changed: the aggregators are all we have,
 * so they must agree with each other and there must be at least two of them.
 */
function reachConsensus(observations: readonly PriceObservation[]): Consensus {
  const providers = observations.filter(observation => observation.kind === 'provider');
  const aggregators = observations.filter(observation => observation.kind === 'aggregator');

  // No provider outranks another, so two of them pricing one model must agree.
  // Nothing registers two providers for one id today; this is what happens if
  // something ever does, rather than an arbitrary first-one-wins.
  const providerConflict = firstDisagreement(providers);
  if (providerConflict) return conflict(providerConflict, 'mutual');

  const provider = providers[0];
  if (!provider) {
    const aggregatorConflict = firstDisagreement(aggregators);
    if (aggregatorConflict) return conflict(aggregatorConflict, 'mutual');
    if (aggregators.length < 2) return { kind: 'lone', observation: aggregators[0] };
    return {
      kind: 'trusted',
      observation: aggregators[0],
      valueSources: aggregators.map(observation => observation.source),
      corroborating: [],
      dissenting: [],
    };
  }

  const agrees = (observation: PriceObservation) =>
    !diverges(provider.price, observation.price, PRICE_AGREEMENT_TOLERANCE);
  const corroborating = aggregators.filter(agrees);
  const dissenting = aggregators.filter(observation => !agrees(observation));
  // Primary, not unaccountable: where mirrors exist, one of them has to back the
  // provider up. All of them dissenting is the shape of a parser that broke
  // against a docs restructure, which is exactly what must not reprice anything.
  if (aggregators.length > 0 && corroborating.length === 0) {
    return conflict([provider, dissenting[0]], 'uncorroborated');
  }
  return { kind: 'trusted', observation: provider, valueSources: [provider.source], corroborating, dissenting };
}

/**
 * The refusal, in the operator's terms. 'mutual' is two sources of equal standing
 * contradicting each other; 'uncorroborated' is a provider price that nothing
 * backs up. Passed in rather than inferred from the pair, because two providers
 * disagreeing is 'mutual' even though both sides are providers.
 */
function conflict([left, right]: [PriceObservation, PriceObservation], reason: 'mutual' | 'uncorroborated'): Consensus {
  const opening =
    reason === 'uncorroborated'
      ? `no source corroborates the provider within ${pct(PRICE_AGREEMENT_TOLERANCE)}`
      : `sources disagree beyond ${pct(PRICE_AGREEMENT_TOLERANCE)}`;
  return {
    kind: 'conflict',
    proposed: left.price,
    detail:
      `${opening}: ${left.source} ${describe(left.price)} vs ${right.source} ${describe(right.price)}; ` +
      'applied neither',
  };
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
 * Disagreement over any rate BOTH sides publish, in the base rates or in a
 * long-context bracket. A rate only one of them carries is silence rather than a
 * contradiction: models.dev quoting cache_read where litellm does not is the
 * ordinary case and may not read as a conflict.
 *
 * Two sides that BOTH publish a ladder must describe the SAME one, down to the
 * breakpoints. Comparing only the base rates would let two sources that agree on
 * the short-prompt price write one of their upper rates with no corroboration.
 */
function diverges(a: DiscoveredPrice, b: DiscoveredPrice, tolerance: number): boolean {
  if (ratesDiverge(a, b, tolerance)) return true;

  const left = a.brackets;
  const right = b.brackets;
  // A ladder only one side publishes is silence, NOT divergence - deliberately, and it is
  // load-bearing. An uncorroborated ladder is refused by the ladderUncorroborated check in
  // planPriceWrites, which fires only when the row in force is already tiered. Repeating that
  // judgement here would also block a FLAT row from taking the base rates, a write whose
  // brackets get discarded anyway. Both are covered by tests; if a static analyzer suggests
  // treating a one-sided ladder as divergence, that is the case it is missing.
  if (!left || !right) return false;
  if (left.length !== right.length) return true;

  return left.some(
    (bracket, index) => bracket.aboveTokens !== right[index].aboveTokens || ratesDiverge(bracket, right[index], tolerance)
  );
}

function ratesDiverge(a: DiscoveredRates, b: DiscoveredRates, tolerance: number): boolean {
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
  const [threshold] = thresholdsOf(row);
  return threshold === undefined ? undefined : [threshold, row.pricing[threshold]];
}

const lowestTier = (row: Pick<IModelPrice, 'pricing'>): IModelPriceTier | undefined => lowestTierEntry(row)?.[1];

/** The row's thresholds in NUMERIC order; the keys are stringified numbers, so a plain sort() would put 1050000 before 272000. */
const thresholdsOf = (row: Pick<IModelPrice, 'pricing'>): string[] =>
  Object.keys(row.pricing).sort((a, b) => Number(a) - Number(b));

/**
 * A ladder discovery must not flatten: more than one threshold. A single tier is
 * flat whatever key it carries - the seed keys its one tier at the model's
 * context window, so reading '0' as the only flat shape would freeze nearly
 * every seeded row. An empty map counts as a ladder, which fails closed.
 */
const isTiered = (row: IModelPrice): boolean => Object.keys(row.pricing).length !== 1;

/** One tier of a planned row: where it is stored, what it would say, and what the band measures it against. */
interface PlannedTier {
  /** Threshold key in the stored pricing map. */
  key: string;
  price: DiscoveredRates;
  /** The run-start row's tier under the same key; absent when there is nothing to band against. */
  baseline?: IModelPriceTier;
}

type LadderPlan = { tiers: PlannedTier[] } | { blocked: string };

/**
 * Map a bracketed observation onto the ladder the row in force already carries,
 * or say why it cannot be mapped (`blocked` completes the flag's sentence).
 *
 * Our tier keys are bracket UPPER bounds - tierForTokens in common/src/models.ts
 * picks the first threshold >= the prompt's input tokens - while both feeds
 * publish a base rate plus "above N tokens" rates. So the base rate belongs to the
 * LOWEST key and each bracket to the key above its own breakpoint, which lines up
 * only when the row's thresholds except its highest ARE the breakpoints. For a
 * 272k/1050000 row against one bracket above 272k: [272000] == [272000], so the
 * base is the up-to-272k tier and the bracket is the up-to-1050000 one.
 *
 * Any other shape would need a threshold we invented, and an invented threshold
 * bills long prompts at the wrong end of the ladder.
 */
function planLadder(row: IModelPrice, observed: DiscoveredPrice, bandRow: IModelPrice | undefined): LadderPlan {
  const brackets = observed.brackets;
  if (!brackets?.length) return { blocked: 'the sources publish one flat rate' };

  const thresholds = thresholdsOf(row);
  const breakpoints = brackets.map(bracket => bracket.aboveTokens);
  const aligned =
    thresholds.length === brackets.length + 1 &&
    thresholds.slice(0, -1).every((threshold, index) => Number(threshold) === breakpoints[index]);
  if (!aligned) {
    return { blocked: `the sources' brackets above ${breakpoints.join(', ')} do not line up with them` };
  }

  const tiers = thresholds.map((key, index) => ({
    key,
    price: index === 0 ? observed : brackets[index - 1],
    baseline: bandRow?.pricing[key],
  }));
  // Per-tier banding is what makes an unattended ladder write safe, so a tier with
  // no run-start counterpart is not one this planner may write.
  const unbanded = tiers.filter(tier => !tier.baseline).map(tier => tier.key);
  if (unbanded.length > 0) {
    return { blocked: `the row this run started from has no tier at ${unbanded.join(', ')} to band against` };
  }
  return { tiers };
}

/**
 * The tiers being superseded, in the shape describe() prints: the lowest tier's
 * rates plus one bracket per tier above it, each keyed by the threshold BELOW it,
 * which is the token count its rates start applying at.
 */
function baselineAsPrice(planned: readonly PlannedTier[]): DiscoveredPrice | undefined {
  const base = planned[0]?.baseline;
  if (!base) return undefined;

  const price: DiscoveredPrice = tierAsPrice(base);
  const brackets: DiscoveredPriceBracket[] = [];
  for (const [index, tier] of planned.slice(1).entries()) {
    if (tier.baseline) brackets.push({ aboveTokens: Number(planned[index].key), ...tierAsPrice(tier.baseline) });
  }
  if (brackets.length > 0) price.brackets = brackets;
  return price;
}

/**
 * Every rate the band applies to: the two text rates, plus a cache rate when the
 * row in force carries it AND this observation quotes it. Each move is a ratio of
 * the two rates rather than a fraction of either one, so the setting means the
 * same multiple whichever way the price went (200% is "up to 3x", up or down).
 *
 * `tierKey` qualifies the rate names for a multi-tier plan, where 'input' alone
 * would not say which tier of the ladder moved.
 */
function bandMoves(
  proposed: DiscoveredRates,
  current: IModelPriceTier,
  tierKey?: string
): Array<{ rate: string; move: number }> {
  const moves: Array<{ rate: string; move: number }> = [];
  for (const [observed, field] of OBSERVED_RATES) {
    const next = proposed[observed];
    const held = current[field];
    if (next === undefined || held === undefined) continue;
    moves.push({ rate: tierKey ? `${field}@${tierKey}` : field, move: baselineMove(next, held * TOKENS_PER_MTOK) });
  }
  return moves;
}

/**
 * How far apart two rates are, as the larger over the smaller minus one: a 3x move
 * is 200% whether the price tripled or fell to a third. A fraction of the current
 * rate would instead saturate at 100% for any cut, which is every band of 100 or
 * more silently disabled in that direction.
 *
 * Leaving OR reaching a zero rate exceeds any band: nothing is a multiple of 0. A
 * negative rate cannot reach this point, and fails the band the same way if it ever does.
 */
const baselineMove = (proposed: number, current: number): number => {
  // NaN compares false against any band, so an unusable rate would pass it.
  if (!Number.isFinite(proposed) || !Number.isFinite(current)) return Number.POSITIVE_INFINITY;
  if (proposed === current) return 0;
  const smaller = Math.min(proposed, current);
  const larger = Math.max(proposed, current);
  return smaller <= 0 ? Number.POSITIVE_INFINITY : larger / smaller - 1;
};

/**
 * The tier a row would carry. Cache and audio rates the feed does not publish
 * are carried forward from the row being superseded: dropping them would
 * silently move cached reads and voice minutes onto the text rate, which is a
 * billing change nobody asked for.
 */
function buildTier(price: DiscoveredRates, carry: IModelPriceTier | undefined): IModelPriceTier {
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

const tierAsPrice = (tier: IModelPriceTier): DiscoveredRates => {
  const price: DiscoveredRates = {
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
 * Every rate the observation carries, cache rates and long-context brackets
 * included: a disagreement can live entirely in cache_read or in an upper bracket,
 * and a detail line that only prints the base input and output would then show two
 * identical prices "disagreeing" - the opposite of the explainable-line-by-line
 * contract the flags exist to meet.
 */
const describe = (price: DiscoveredPrice): string =>
  [rateList(price), ...(price.brackets ?? []).map(bracket => `above ${bracket.aboveTokens} ${rateList(bracket)}`)].join(
    ', '
  );

const rateList = (rates: DiscoveredRates): string => {
  const parts = [`in ${readable(rates.inputPerMTok)}`, `out ${readable(rates.outputPerMTok)}`];
  if (rates.cacheReadPerMTok !== undefined) parts.push(`cache_read ${readable(rates.cacheReadPerMTok)}`);
  if (rates.cacheWritePerMTok !== undefined) parts.push(`cache_write ${readable(rates.cacheWritePerMTok)}`);
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
