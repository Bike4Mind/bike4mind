/**
 * Pure helpers for the retained-bucket + lifecycle patterns used across product
 * infra. Like the rest of this package, nothing here constructs cloud resources;
 * the helpers compute names and plain argument objects the product feeds into
 * `new sst.aws.Bucket(...)` / `new aws.s3.BucketLifecycleConfigurationV2(...)`.
 */

/** Stages whose buckets are retained on delete (data safety). */
export const RETAINED_BUCKET_STAGES = ['production', 'dev'] as const;

export interface RetainedBucketNameOptions {
  /** Deploy stage, e.g. $app.stage. */
  stage: string;
  /** App name, e.g. $app.name. */
  appName: string;
  /**
   * Physical-name suffix from the legacy buckets stack, e.g. 'fabfilesbucket'.
   * Passed explicitly because legacy suffixes do not always match the SST
   * logical name (e.g. logical 'fabFileBucket' -> physical 'fabfilesbucket').
   */
  suffix: string;
  /** Explicit physical name override (typically from an env var). Wins outright. */
  override?: string;
  /** Stages that get a stable physical name. Defaults to production + dev. */
  retainedStages?: readonly string[];
}

/**
 * Resolves the stable physical bucket name for retained stages, or undefined on
 * ephemeral stages (PR stages etc.), where SST auto-names and auto-deletes.
 */
export function retainedBucketName(options: RetainedBucketNameOptions): string | undefined {
  const { stage, appName, suffix, override, retainedStages = RETAINED_BUCKET_STAGES } = options;
  if (override) return override;
  return retainedStages.includes(stage) ? `${stage}-${appName}-buckets-${suffix}` : undefined;
}

/**
 * Component options for a bucket resolved via retainedBucketName: named buckets
 * are retained on delete; unnamed (ephemeral-stage) buckets are destroyed.
 */
export function bucketRetention(physicalName: string | undefined): { retainOnDelete: boolean } {
  return { retainOnDelete: physicalName !== undefined };
}

/** Plain-object shape of an aws.s3.BucketLifecycleConfigurationV2 rule. */
export interface BucketLifecycleRule {
  id: string;
  status: 'Enabled';
  filter?: { prefix: string };
  expiration?: { days: number };
  noncurrentVersionExpiration?: { noncurrentDays: number };
  abortIncompleteMultipartUpload?: { daysAfterInitiation: number };
}

export interface ExpireAfterDaysOptions {
  id: string;
  days: number;
  /** Restrict the rule to keys under this prefix; omit for the whole bucket. */
  prefix?: string;
  /** Days before abandoned multipart uploads are cleaned up. Defaults to 1. */
  abortIncompleteUploadDays?: number;
}

/** Rule expiring current objects after N days (temporary/derived data cleanup). */
export function expireAfterDays(options: ExpireAfterDaysOptions): BucketLifecycleRule {
  const { id, days, prefix, abortIncompleteUploadDays = 1 } = options;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`expireAfterDays: days must be a positive integer for rule "${id}", got ${days}`);
  }
  return {
    id,
    status: 'Enabled',
    ...(prefix ? { filter: { prefix } } : {}),
    expiration: { days },
    abortIncompleteMultipartUpload: { daysAfterInitiation: abortIncompleteUploadDays },
  };
}

/** Rule expiring noncurrent object versions after N days (versioned buckets). */
export function expireNoncurrentVersionsAfterDays(id: string, days: number): BucketLifecycleRule {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`expireNoncurrentVersionsAfterDays: days must be a positive integer for rule "${id}", got ${days}`);
  }
  return {
    id,
    status: 'Enabled',
    noncurrentVersionExpiration: { noncurrentDays: days },
  };
}
