import { BLOCK_ALL_PUBLIC_ACCESS, encryptBucketAtRest } from './bucketSecurity';

// One shared cache, hosted on the staging stage only. CI and developers point at a single
// endpoint, and production's `removal: 'retain'` would orphan the bucket if it were ever dropped.
const isHostedStage = !$dev && $app.stage === 'dev';

// Declared here, not in infra/secrets.ts: everything in that map reaches `allSecrets`, which is
// linked into every app Lambda. The cache tokens are build-supply-chain credentials, so they are
// linked into the cache handler alone. Generate each with: openssl rand -hex 32
// TURBO_CACHE_TOKEN is the CI read/write token; TURBO_CACHE_READ_TOKEN cannot obtain upload URLs.
const turboCacheWriteToken = isHostedStage ? new sst.Secret('TURBO_CACHE_TOKEN', 'not-configured') : undefined;
const turboCacheReadToken = isHostedStage ? new sst.Secret('TURBO_CACHE_READ_TOKEN', 'not-configured') : undefined;

function createTurboCacheBucket() {
  const turboCacheBucket = new sst.aws.Bucket('turboCacheBucket', {
    versioning: false,
    transform: { publicAccessBlock: BLOCK_ALL_PUBLIC_ACCESS },
  });
  encryptBucketAtRest('turboCacheBucket', turboCacheBucket);
  return turboCacheBucket;
}

export const turboCacheBucket = isHostedStage ? createTurboCacheBucket() : undefined;

export const turboCacheBucketLifecycle = turboCacheBucket
  ? new aws.s3.BucketLifecycleConfigurationV2('turboCacheBucketLifecycle', {
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
    })
  : undefined;

const turboCacheFunction =
  turboCacheBucket && turboCacheWriteToken && turboCacheReadToken
    ? new sst.aws.Function('TurboCacheHandler', {
        handler: 'apps/workers/src/turboCache/handler.handler',
        runtime: 'nodejs24.x',
        timeout: '30 seconds',
        memory: '512 MB',
        // The Function URL is public (bearer auth runs in the handler), so cap it: unauthenticated
        // traffic must not draw down the account concurrency the app's Lambdas share.
        concurrency: { reserved: 20 },
        // The bucket is passed by name, not linked: an SST bucket link grants `s3:*`, including
        // delete and bucket-policy actions. The handler only reads, writes and presigns objects.
        // ListBucket keeps a HeadObject miss a 404; without it S3 answers 403.
        link: [turboCacheWriteToken, turboCacheReadToken],
        environment: { TURBO_CACHE_BUCKET: turboCacheBucket.name },
        permissions: [
          { actions: ['s3:GetObject', 's3:PutObject'], resources: [$interpolate`${turboCacheBucket.arn}/*`] },
          { actions: ['s3:ListBucket'], resources: [turboCacheBucket.arn] },
        ],
        url: { cors: false },
      })
    : undefined;

export const turboCacheUrl = turboCacheFunction?.url;
