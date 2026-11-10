import { PRODUCTION_STAGES } from './constants';

const isHostedStage = !$dev && PRODUCTION_STAGES.includes($app.stage);

// Declared here, not in infra/secrets.ts: everything in that map reaches `allSecrets`, which is
// linked into every app Lambda. The cache tokens are build-supply-chain credentials, so they are
// linked into the cache handler alone. Generate each with: openssl rand -hex 32
// TURBO_CACHE_TOKEN is the CI read/write token; TURBO_CACHE_READ_TOKEN cannot obtain upload URLs.
const turboCacheWriteToken = isHostedStage ? new sst.Secret('TURBO_CACHE_TOKEN', 'not-configured') : undefined;
const turboCacheReadToken = isHostedStage ? new sst.Secret('TURBO_CACHE_READ_TOKEN', 'not-configured') : undefined;

export const turboCacheBucket = isHostedStage
  ? new sst.aws.Bucket('turboCacheBucket', {
      versioning: false,
    })
  : undefined;

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
        link: [turboCacheBucket, turboCacheWriteToken, turboCacheReadToken],
        url: { cors: false },
      })
    : undefined;

export const turboCacheUrl = turboCacheFunction?.url;
