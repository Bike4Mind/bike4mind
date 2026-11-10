import { PRODUCTION_STAGES } from './constants';
import { secrets } from './secrets';

const isHostedStage = !$dev && PRODUCTION_STAGES.includes($app.stage);

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

const turboCacheFunction = isHostedStage
  ? new sst.aws.Function('TurboCacheHandler', {
      handler: 'apps/workers/src/turboCache/handler.handler',
      runtime: 'nodejs24.x',
      timeout: '30 seconds',
      memory: '512 MB',
      link: [turboCacheBucket!, secrets.TURBO_CACHE_TOKEN, secrets.TURBO_CACHE_READ_TOKEN],
      url: { cors: false },
    })
  : undefined;

export const turboCacheUrl = turboCacheFunction?.url;
