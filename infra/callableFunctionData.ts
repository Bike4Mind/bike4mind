import { BLOCK_ALL_PUBLIC_ACCESS } from './bucketSecurity';
import { PRODUCTION_STAGES } from './constants';

// Data files for callable functions, keyed by callableFunctionDataKey (packages/server-utils). A raw bucket because
// sst.aws.Bucket resolves its name only after its own policy, which here names a role that needs that name first.
const retained = PRODUCTION_STAGES.includes($app.stage);

export const callableFunctionDataBucket = new aws.s3.Bucket(
  'CallableFunctionDataBucket',
  { forceDestroy: !retained },
  { retainOnDelete: retained }
);

export const callableFunctionDataPublicAccessBlock = new aws.s3.BucketPublicAccessBlock(
  'CallableFunctionDataPublicAccessBlock',
  { bucket: callableFunctionDataBucket.bucket, ...BLOCK_ALL_PUBLIC_ACCESS }
);

new aws.s3.BucketServerSideEncryptionConfiguration('CallableFunctionDataEncryption', {
  bucket: callableFunctionDataBucket.bucket,
  rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
});

/** The function's objects, for the web API function's grant. */
export const callableFunctionDataObjects = $interpolate`${callableFunctionDataBucket.arn}/*`;
