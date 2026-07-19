/**
 * ACT-R base-level activation - what makes salience COMPUTED and DECAYING instead of a static label.
 *
 * A belief's history in the ledger is a series of PRESENTATIONS (its assert, plus every affirm).
 * Anderson's base-level learning equation turns that history into one number that folds together
 * RECENCY (recent presentations count for more) and FREQUENCY (more presentations sum to more):
 *
 *     B = ln( sum_j  dt_j^(-d) )
 *
 * where dt_j is the elapsed time since presentation j and d is the decay exponent (0.5 canonical).
 * A belief affirmed recently and often is hot; one last touched long ago decays toward cold on its
 * own, with no groom required. Time is measured in DAYS here (memory operates on a human calendar,
 * not the seconds of the original psychology experiments); the absolute scale is arbitrary, only
 * the ordering and the thresholds matter, and both are configurable.
 */

const DAY_MS = 86_400_000;

export interface ActivationConfig {
  /** Decay exponent d; 0.5 is the ACT-R canonical default. */
  decay: number;
  /** Floor on elapsed time (days) so a just-now presentation is not a singularity. */
  floorDays: number;
  /** Activation strictly above this tiers to `hot`. */
  hotAbove: number;
  /** Activation strictly above this (but not `hot`) tiers to `warm`; at or below is `cold`. */
  warmAbove: number;
}

/**
 * Defaults tuned for the day timescale: a single presentation ~1 day old sits near the hot/warm
 * line; a lone presentation a week out is warm; a month out is cold. Frequency lifts a belief back
 * up. Override per principal as real usage tells us where the lines belong.
 */
export const DEFAULT_ACTIVATION: ActivationConfig = {
  decay: 0.5,
  floorDays: 0.5,
  hotAbove: 0,
  warmAbove: -1.2,
};

/** Base-level activation from presentation times (ms since epoch), evaluated as of `nowMs`. */
export function baseLevelActivation(
  presentationsMs: readonly number[],
  nowMs: number,
  config: ActivationConfig = DEFAULT_ACTIVATION
): number {
  const floorMs = config.floorDays * DAY_MS;
  let sum = 0;
  for (const t of presentationsMs) {
    const dtDays = Math.max(nowMs - t, floorMs) / DAY_MS;
    sum += Math.pow(dtDays, -config.decay);
  }
  return sum > 0 ? Math.log(sum) : Number.NEGATIVE_INFINITY;
}

/** Threshold an activation value into a hot/warm/cold salience tier. */
export function activationToSalience(
  activation: number,
  config: ActivationConfig = DEFAULT_ACTIVATION
): 'hot' | 'warm' | 'cold' {
  if (activation > config.hotAbove) return 'hot';
  if (activation > config.warmAbove) return 'warm';
  return 'cold';
}
