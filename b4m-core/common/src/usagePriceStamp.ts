import { pricingTierForTokens, resolveAppliedRates, type ModelInfo, type TurnUsage } from './models';
import {
  USAGE_EVENT_TURN_USAGE_CAP,
  type IUsageEventTurn,
  type UsagePriceStamp,
} from './types/entities/UsageEventTypes';

/** What the cost was priced over; mirrors the arguments of getTurnsCost / getTextModelCost. */
export type UsagePriceStampBasis = {
  /** The getTurnsCost input. More than one turn also stamps the per-turn breakdown. */
  turns?: readonly TurnUsage[];
  /** The tierBasisTokens of the getTextModelCost call; read when there are no turns. */
  tierBasisTokens?: number;
  /**
   * The cost priced a local estimate rather than provider usage: cache writes are not billed at
   * all. Rate the stamp the same way, or the stored rates would recompute to a charge that was
   * never made.
   */
  localEstimate?: boolean;
};

// Same whole-prompt basis getTurnsCost tiers each request on.
const promptTokens = (turn: TurnUsage): number =>
  turn.inputTokens + (turn.cacheReadInputTokens ?? 0) + (turn.cacheCreationInputTokens ?? 0);

const turnEntry = (turn: TurnUsage, tierKey: number): IUsageEventTurn => ({
  inputTokens: turn.inputTokens,
  outputTokens: turn.outputTokens,
  ...(turn.cacheReadInputTokens ? { cacheReadTokens: turn.cacheReadInputTokens } : {}),
  ...(turn.cacheCreationInputTokens ? { cacheWriteTokens: turn.cacheCreationInputTokens } : {}),
  tierKey,
});

/**
 * Price provenance for a text-model UsageEvent: where the rates came from and which tier of them
 * priced the call, so a refund or audit can recompute the charge. Pass the same turns or tier basis
 * the cost was computed from.
 *
 * `rates` is the tier of the largest turn. More than one turn adds `turnUsage`, one entry per turn;
 * past USAGE_EVENT_TURN_USAGE_CAP the entries after the first CAP - 1 collapse into one summed
 * tail (its tierKey is the highest tier in it) and `turnUsageTruncated` is set. A model with no
 * priced tier gets the source only, since there is no tier to name.
 *
 * `rates` describes one tier, so a row it stamps is exactly recomputable only when every turn
 * priced at that tier. When turns span tiers, `turnUsage[].tierKey` names each turn's tier but the
 * other tiers' rates are not stored, and a truncated tail sums turns of several tiers under one
 * key: treat such a row as indicative, not auditable to the cent.
 *
 * Never throws: the stamp is analytics on a settlement path, and a malformed model must not take
 * the charge or the UsageEvent down with it.
 */
export function buildUsagePriceStamp(model: ModelInfo, basis: UsagePriceStampBasis): UsagePriceStamp {
  try {
    return stampFor(model, basis);
  } catch {
    return { priceSource: model.priceSource ?? 'literal' };
  }
}

function stampFor(model: ModelInfo, basis: UsagePriceStampBasis): UsagePriceStamp {
  const turns = basis.turns ?? [];
  const tierBasisTokens = turns.length
    ? turns.reduce((largest, turn) => Math.max(largest, promptTokens(turn)), 0)
    : (basis.tierBasisTokens ?? 0);
  const resolved = resolveAppliedRates(model, tierBasisTokens);
  const rates = resolved && basis.localEstimate ? { ...resolved, cacheWrite: 0 } : resolved;

  const stamp: UsagePriceStamp = {
    priceSource: model.priceSource ?? 'literal',
    ...(model.priceSource === 'catalog' && model.priceRowId ? { priceRowId: model.priceRowId } : {}),
    ...(rates ? { rates } : {}),
  };
  if (!rates || turns.length < 2) return stamp;

  const tierOf = (turn: TurnUsage): number => pricingTierForTokens(model, promptTokens(turn)) ?? rates.tierKey;
  if (turns.length <= USAGE_EVENT_TURN_USAGE_CAP) {
    return { ...stamp, turnUsage: turns.map(turn => turnEntry(turn, tierOf(turn))) };
  }

  const kept = turns.slice(0, USAGE_EVENT_TURN_USAGE_CAP - 1);
  const tail = turns.slice(USAGE_EVENT_TURN_USAGE_CAP - 1);
  const tailSum = tail.reduce<TurnUsage>(
    (sum, turn) => ({
      inputTokens: sum.inputTokens + turn.inputTokens,
      outputTokens: sum.outputTokens + turn.outputTokens,
      cacheReadInputTokens: (sum.cacheReadInputTokens ?? 0) + (turn.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: (sum.cacheCreationInputTokens ?? 0) + (turn.cacheCreationInputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 }
  );
  const tailTier = tail.reduce((highest, turn) => Math.max(highest, tierOf(turn)), 0);
  return {
    ...stamp,
    turnUsage: [...kept.map(turn => turnEntry(turn, tierOf(turn))), turnEntry(tailSum, tailTier)],
    turnUsageTruncated: true,
  };
}
