import { secrets } from './secrets';

// S3 bucket for Turborepo remote cache artifacts. Artifacts are keyed by content hash
// so they are inherently deduplicated. A 30-day lifecycle keeps the bucket from growing
// unboundedly -- any hash not hit in 30 days is rebuilt on the next CI run.
export const turboCacheBucket = new sst.aws.Bucket('turboCacheBucket', {
  versioning: false,
});

export const turboCacheBucketLifecycle = new aws.s3.BucketLifecycleConfigurationV2('turboCacheBucketLifecycle', {
  bucket: turboCacheBucket.name,
  rules: [
    {
      id: 'expire-stale-artifacts',
      status: 'Enabled',
      filter: {},
      expiration: { days: 30 },
      abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
    },
  ],
});

// Lambda-backed API implementing the Turborepo remote cache protocol (GET/PUT/HEAD
// artifacts by hash, POST events). Authentication is a shared bearer token stored as
// an SST secret. Exposed via a Function URL (no API Gateway overhead).
const turboCacheFunction = new sst.aws.Function('TurboCacheHandler', {
  handler: 'apps/workers/src/turboCache/handler.handler',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: '512 MB',
  link: [turboCacheBucket, secrets.TURBO_CACHE_TOKEN],
  url: true,
});

export const turboCacheUrl = turboCacheFunction.url;
