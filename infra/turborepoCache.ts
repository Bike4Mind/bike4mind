import { BLOCK_ALL_PUBLIC_ACCESS, encryptBucketAtRest } from './bucketSecurity';
import { dlqAlarmTopic } from './dlqAlarms';

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

export const TURBO_CACHE_ALARM_NAMESPACE = 'Lumina5/TurboCache';
/** Refused credentials (401) per 5 minutes. Read-only upload 403s are routine for developers and not counted. */
export const TURBO_CACHE_REJECTED_PER_5MIN = 50;
/** Any throttle means the reserved concurrency cap is full. */
export const TURBO_CACHE_THROTTLES_PER_5MIN = 1;
/** Any failed invocation: S3 failures are rethrown, and Turbo reads a failed request as a miss. */
export const TURBO_CACHE_ERRORS_PER_5MIN = 1;
/** Artifacts expire after 30 days, so steady-state size tracks a month of builds. */
export const TURBO_CACHE_BUCKET_SIZE_BYTES = 200 * 1024 ** 3;

function createTurboCacheAlarms(fn: sst.aws.Function, bucket: sst.aws.Bucket) {
  // The hosted stage (`dev`) is a monitored stage, so its alarm topic exists.
  if (!dlqAlarmTopic) throw new Error('turbo cache alarms require dlqAlarmTopic');
  const actions = [dlqAlarmTopic.arn];
  const prefix = `${$app.name}-${$app.stage}`;
  const tags = { Application: 'TurboCache', Severity: 'Warning' };

  // The handler logs `turbo cache request rejected` (apps/workers/src/turboCache/handler.ts) for each
  // refused credential on the public Function URL.
  new aws.cloudwatch.LogMetricFilter('turboCacheRejectedFilter', {
    name: `${prefix}-turbo-cache-rejected`,
    logGroupName: fn.nodes.logGroup.apply(group => {
      if (!group) throw new Error('TurboCacheHandler is missing its CloudWatch log group');
      return group.name;
    }),
    // Counts 401s only; same top-level message selector as logMessageFilterPattern.ts.
    pattern: '{ $.message = "turbo cache request rejected" && $.statusCode = 401 }',
    metricTransformation: {
      name: 'RejectedRequests',
      namespace: TURBO_CACHE_ALARM_NAMESPACE,
      value: '1',
      unit: 'Count',
    },
  });

  const rejected = new aws.cloudwatch.MetricAlarm('turboCacheRejected', {
    name: `${prefix}-turbo-cache-rejected`,
    alarmDescription: `Turbo cache refused ${TURBO_CACHE_REJECTED_PER_5MIN}+ credentials in 5 minutes: probing of the public endpoint or a stale CI token`,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'RejectedRequests',
    namespace: TURBO_CACHE_ALARM_NAMESPACE,
    period: 300,
    statistic: 'Sum',
    threshold: TURBO_CACHE_REJECTED_PER_5MIN,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags,
  });

  const throttles = new aws.cloudwatch.MetricAlarm('turboCacheThrottles', {
    name: `${prefix}-turbo-cache-throttles`,
    alarmDescription: 'TurboCacheHandler hit its reserved concurrency cap: cache requests are being throttled',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'Throttles',
    namespace: 'AWS/Lambda',
    dimensions: { FunctionName: fn.nodes.function.name },
    period: 300,
    statistic: 'Sum',
    threshold: TURBO_CACHE_THROTTLES_PER_5MIN,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags,
  });

  // The handler rethrows unexpected S3 failures, and Turbo treats a failed request as a cache miss,
  // so without this alarm a broken cache (for example a permissions gap) looks like a slow build.
  const errors = new aws.cloudwatch.MetricAlarm('turboCacheErrors', {
    name: `${prefix}-turbo-cache-errors`,
    alarmDescription: 'TurboCacheHandler invocations are failing: cache reads and writes are falling back to misses',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'Errors',
    namespace: 'AWS/Lambda',
    dimensions: { FunctionName: fn.nodes.function.name },
    period: 300,
    statistic: 'Sum',
    threshold: TURBO_CACHE_ERRORS_PER_5MIN,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags,
  });

  // S3 publishes BucketSizeBytes once a day.
  const bucketSize = new aws.cloudwatch.MetricAlarm('turboCacheBucketSize', {
    name: `${prefix}-turbo-cache-bucket-size`,
    alarmDescription: 'Turbo cache bucket is above its expected size: check for oversized or unexpected uploads',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'BucketSizeBytes',
    namespace: 'AWS/S3',
    dimensions: { BucketName: bucket.name, StorageType: 'StandardStorage' },
    period: 86400,
    statistic: 'Maximum',
    threshold: TURBO_CACHE_BUCKET_SIZE_BYTES,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags,
  });

  return { rejected, throttles, errors, bucketSize };
}

export const turboCacheAlarms =
  turboCacheFunction && turboCacheBucket ? createTurboCacheAlarms(turboCacheFunction, turboCacheBucket) : undefined;
