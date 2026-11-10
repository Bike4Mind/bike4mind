/**
 * Shared S3 security settings. Every `new sst.aws.Bucket` must pass BLOCK_ALL_PUBLIC_ACCESS as
 * `transform.publicAccessBlock` and be followed by `encryptBucketAtRest(...)`;
 * infra/__tests__/bucketSecurity.test.ts enforces both.
 *
 * Block Public Access goes through SST's transform because SST already owns that resource; encryption
 * is a separate resource because SST has no seam for it.
 */
export const BLOCK_ALL_PUBLIC_ACCESS = {
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
} as const;

/** SSE-S3 default encryption on the bucket. */
export function encryptBucketAtRest(name: string, bucket: sst.aws.Bucket) {
  return new aws.s3.BucketServerSideEncryptionConfiguration(`${name}Encryption`, {
    bucket: bucket.name,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
  });
}
