import {
  EVAL_SET_CALIBRATION_BUCKETS,
  type EvalSetCalibration,
  type EvalSetCalibrationBucket,
} from '@client/app/utils/verdictEvalSets';
import { ratio, type EvalAssessment } from './gradeVerdicts';

/**
 * Calibration of the advisory assessment model on an evaluation set: how often the accounts it gave
 * a p(abuse) of x turned out to be abuse. Pure; evalSetMath.ts gradeEvalSet calls it.
 *
 * p(abuse) is the `abuse` entry of the stored distribution, not `confidence`: confidence is the
 * shared choice formula in b4m-core/common/src/decisions/confidence.ts (0 for a uniform distribution,
 * 1 for a certain one), so it is no probability and says nothing about p(abuse) on a non-abuse answer.
 */

export type CalibratedAssessment = EvalAssessment & {
  /** The distribution's `abuse` probability; null when the stored distribution has none. */
  abuseProbability: number | null;
};

/**
 * The `abuse` probability of a stored distribution, renormalised by the stored entries' sum (the
 * raw probabilities need not sum to exactly 1, see common/src/decisions/normalize.ts). Null when
 * there is no abuse entry, the sum is not positive, or the result falls outside [0, 1]. The admin
 * advisories list (server-utils aiAbuseAdvisories.ts abuseProbabilityOf) shows the raw entry, so a
 * distribution that sums below 1 reads higher here than there.
 */
export function renormalisedAbuseProbability(
  probabilities: readonly { value: string; probability: number }[]
): number | null {
  const entry = probabilities.find(candidate => candidate.value === 'abuse');
  if (!entry) return null;
  const total = probabilities.reduce((sum, candidate) => sum + candidate.probability, 0);
  if (!Number.isFinite(entry.probability) || !Number.isFinite(total) || total <= 0) return null;
  const normalised = entry.probability / total;
  return normalised >= 0 && normalised <= 1 ? normalised : null;
}

/**
 * The p(abuse) an example is calibrated on: each detection's newest assessment (the one the grader
 * scores) that has an answer and a p(abuse), then the highest across detections, mirroring the
 * scoreboard's "any detection positive" rule. Null when none qualifies.
 */
export function calibrationProbability(
  detectionIds: readonly string[],
  newestByDetection: ReadonlyMap<string, CalibratedAssessment>
): number | null {
  let highest: number | null = null;
  for (const detectionId of detectionIds) {
    const row = newestByDetection.get(detectionId);
    if (!row || row.abuseProbability === null || row.result === 'unknown') continue;
    if (highest === null || row.abuseProbability > highest) highest = row.abuseProbability;
  }
  return highest;
}

export type CalibrationPoint = { predicted: number; abuse: boolean };

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const bucketIndex = (predicted: number) =>
  Math.min(EVAL_SET_CALIBRATION_BUCKETS - 1, Math.floor(predicted * EVAL_SET_CALIBRATION_BUCKETS));

/** Brier score and EVAL_SET_CALIBRATION_BUCKETS equal-width buckets over one model's points. */
export function calibrate(
  model: string,
  flaggedLabelled: number,
  points: readonly CalibrationPoint[]
): EvalSetCalibration {
  const outcome = (point: CalibrationPoint) => (point.abuse ? 1 : 0);
  const buckets = Array.from({ length: EVAL_SET_CALIBRATION_BUCKETS }, (_, index): EvalSetCalibrationBucket => {
    const inBucket = points.filter(point => bucketIndex(point.predicted) === index);
    return {
      lower: index / EVAL_SET_CALIBRATION_BUCKETS,
      upper: (index + 1) / EVAL_SET_CALIBRATION_BUCKETS,
      n: inBucket.length,
      meanPredicted: inBucket.length === 0 ? null : round(mean(inBucket.map(point => point.predicted)), 3),
      observedAbuseRate: ratio(inBucket.filter(point => point.abuse).length, inBucket.length),
    };
  });
  return {
    model,
    flaggedLabelled,
    n: points.length,
    brier: points.length === 0 ? null : round(mean(points.map(point => (point.predicted - outcome(point)) ** 2)), 4),
    buckets,
  };
}
