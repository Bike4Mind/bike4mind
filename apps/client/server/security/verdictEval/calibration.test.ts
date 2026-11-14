import { describe, expect, it } from 'vitest';
import {
  abuseProbabilityOf,
  calibrate,
  calibrationProbability,
  type CalibratedAssessment,
  type CalibrationPoint,
} from './calibration';

const points = (predicted: number, total: number, abuse: number): CalibrationPoint[] =>
  Array.from({ length: total }, (_, index) => ({ predicted, abuse: index < abuse }));

describe('abuseProbabilityOf', () => {
  it('reads the abuse entry of the distribution', () => {
    expect(
      abuseProbabilityOf([
        { value: 'legitimate_automation', probability: 0.2 },
        { value: 'abuse', probability: 0.7 },
        { value: 'insufficient_evidence', probability: 0.1 },
      ])
    ).toBe(0.7);
  });

  it('is null without an abuse entry or with one outside [0, 1]', () => {
    expect(abuseProbabilityOf([])).toBeNull();
    expect(abuseProbabilityOf([{ value: 'legitimate_automation', probability: 1 }])).toBeNull();
    expect(abuseProbabilityOf([{ value: 'abuse', probability: 1.2 }])).toBeNull();
    expect(abuseProbabilityOf([{ value: 'abuse', probability: Number.NaN }])).toBeNull();
  });
});

describe('calibrationProbability', () => {
  const row = (
    detectionId: string,
    result: CalibratedAssessment['result'],
    abuseProbability: number | null,
    day: number
  ): CalibratedAssessment => ({
    detectionId,
    result,
    abuseProbability,
    confidence: 0.5,
    model: 'm1',
    assessedAt: new Date(Date.UTC(2026, 10, day)),
  });
  const newest = (...rows: CalibratedAssessment[]) => new Map(rows.map(entry => [entry.detectionId, entry]));

  it('takes the newest assessment across the detections when they disagree', () => {
    const byDetection = newest(row('d1', 'abuse', 0.9, 1), row('d2', 'legitimate_automation', 0.1, 3));
    expect(calibrationProbability(['d1', 'd2'], byDetection)).toBe(0.1);
    expect(calibrationProbability(['d2', 'd1'], byDetection)).toBe(0.1);
  });

  it('skips abstaining assessments and ones without a p(abuse)', () => {
    const byDetection = newest(
      row('d1', 'abuse', 0.8, 1),
      row('d2', 'insufficient_evidence', 0.3, 5),
      row('d3', 'unknown', null, 6),
      row('d4', 'legitimate_automation', null, 7)
    );
    expect(calibrationProbability(['d1', 'd2', 'd3', 'd4'], byDetection)).toBe(0.8);
    expect(calibrationProbability(['d2', 'd3', 'd4'], byDetection)).toBeNull();
  });

  it('is null for an example with no assessed detection', () => {
    expect(calibrationProbability([], newest())).toBeNull();
    expect(calibrationProbability(['missing'], newest(row('d1', 'abuse', 0.9, 1)))).toBeNull();
  });
});

describe('calibrate', () => {
  it('reports matching predicted and observed rates for a calibrated model', () => {
    const report = calibrate('m1', 25, [...points(0.1, 10, 1), ...points(0.9, 10, 9)]);
    expect(report).toMatchObject({ model: 'm1', flaggedLabelled: 25, n: 20, brier: 0.09 });
    expect(report.buckets[0]).toEqual({ lower: 0, upper: 0.2, n: 10, meanPredicted: 0.1, observedAbuseRate: 0.1 });
    expect(report.buckets[4]).toEqual({ lower: 0.8, upper: 1, n: 10, meanPredicted: 0.9, observedAbuseRate: 0.9 });
    expect(report.buckets.slice(1, 4).map(bucket => bucket.n)).toEqual([0, 0, 0]);
  });

  it('shows an overconfident model as observed below predicted, with a higher Brier score', () => {
    const report = calibrate('m1', 10, points(0.95, 10, 5));
    expect(report.buckets[4]).toMatchObject({ n: 10, meanPredicted: 0.95, observedAbuseRate: 0.5 });
    expect(report.brier).toBe(0.4525);
  });

  it('has no Brier score and empty buckets with no points', () => {
    const report = calibrate('m1', 3, []);
    expect(report).toMatchObject({ n: 0, brier: null, flaggedLabelled: 3 });
    expect(report.buckets).toHaveLength(5);
    for (const bucket of report.buckets) {
      expect(bucket).toMatchObject({ n: 0, meanPredicted: null, observedAbuseRate: null });
    }
  });

  it('puts 1 in the last bucket and a bucket boundary in the upper bucket', () => {
    const report = calibrate('m1', 3, [
      { predicted: 1, abuse: true },
      { predicted: 0.2, abuse: false },
      { predicted: 0, abuse: false },
    ]);
    expect(report.buckets.map(bucket => bucket.n)).toEqual([1, 1, 0, 0, 1]);
    expect(report.brier).toBe(0.0133);
  });
});
