import { z } from 'zod';
import type { MobilePlatform } from './versioning';

/**
 * The feature parity matrix (parityMatrix.json, process in docs/mobile-release-train.md): one row
 * per user-facing feature, one status per platform, and the train the feature is due in.
 */

export const PARITY_PLATFORMS = ['web', 'ios', 'android'] as const;
export type ParityPlatform = (typeof PARITY_PLATFORMS)[number];

/** green: shipped or ready to ship. yellow: in progress. red: not started. na: never on this platform. */
export const PARITY_STATUSES = ['green', 'yellow', 'red', 'na'] as const;
export type ParityStatus = (typeof PARITY_STATUSES)[number];

const TRAIN = /^([1-9]\d?)\.([1-9]\d?)$/;

/** Parses a train id `YY.M`, or returns undefined. */
export function parseTrain(value: string): { year: number; month: number } | undefined {
  const match = TRAIN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month <= 12 ? { year, month } : undefined;
}

export function compareTrains(left: string, right: string): number {
  const a = parseTrain(left);
  const b = parseTrain(right);
  if (!a || !b) throw new Error(`Not a train id: ${a ? right : left}`);
  return Math.sign(a.year - b.year || a.month - b.month);
}

const StatusSchema = z.enum(PARITY_STATUSES);

const FeatureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case'),
    title: z.string().min(1),
    train: z
      .string()
      .refine(value => parseTrain(value) !== undefined, 'train must be YY.M, e.g. 26.11')
      .optional(),
    web: StatusSchema,
    ios: StatusSchema,
    android: StatusSchema,
    notes: z.string().optional(),
  })
  .strict();

const MatrixSchema = z
  .object({
    $comment: z.string().optional(),
    features: z.array(FeatureSchema),
  })
  .strict();

export type ParityFeature = z.infer<typeof FeatureSchema>;
export type ParityMatrix = z.infer<typeof MatrixSchema>;

export function parseParityMatrix(raw: unknown): { matrix: ParityMatrix } | { errors: string[] } {
  const parsed = MatrixSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`) };
  }
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const feature of parsed.data.features) {
    if (seen.has(feature.id)) errors.push(`duplicate feature id "${feature.id}"`);
    seen.add(feature.id);
  }
  return errors.length > 0 ? { errors } : { matrix: parsed.data };
}

/** A cell counts as green for gating when the feature is shipped there or never ships there. */
export function isCellGreen(feature: ParityFeature, platform: ParityPlatform): boolean {
  return feature[platform] === 'green' || feature[platform] === 'na';
}

/**
 * The features that block a `platform` build of `train`: due in that train or an earlier one and
 * not green on that platform. A slipped feature unblocks the build only by being retargeted.
 */
export function trainBlockers(matrix: ParityMatrix, platform: MobilePlatform, train: string): ParityFeature[] {
  return matrix.features.filter(
    feature =>
      feature.train !== undefined && compareTrains(feature.train, train) <= 0 && !isCellGreen(feature, platform)
  );
}
