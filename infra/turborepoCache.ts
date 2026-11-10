import { secrets } from './secrets';

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

const turboCacheFunction = new sst.aws.Function('TurboCacheHandler', {
  handler: 'apps/workers/src/turboCache/handler.handler',
  runtime: 'nodejs24.x',
  timeout: '30 seconds',
  memory: '512 MB',
  link: [turboCacheBucket, secrets.TURBO_CACHE_TOKEN],
  url: true,
});

export const turboCacheUrl = turboCacheFunction.url;
