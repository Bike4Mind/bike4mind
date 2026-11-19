import { fabFileBucket, generatedImagesBucket } from './buckets';
import { isPreviewStage, STAGE_LOG_RETENTION } from './constants';
import { dlqAlarmTopic } from './dlqAlarms';
import { ecsEnvSecret, ecsSecretsVersion } from './ecsSecrets';
import { generationJobQueue, renderJobQueue } from './queues';
import { secrets } from './secrets';
import { cluster } from './vpc';

/**
 * Studio render worker
 *
 * Fargate service that encodes Studio compositions (apps/workers/src/render/main.ts, image
 * apps/workers/Dockerfile.renderworker). It long-polls renderJobQueue, renders with ffmpeg, writes the MP4 and a
 * status JSON to the generated images bucket, then hands the job back to generationJobQueue for the engine's store
 * step. The self-host chart runs the same image (selfhost/kubernetes renderWorker values); this is its hosted twin.
 *
 * Resolution: the image CMD loads the sst alias shim, so `Resource.*` resolves from plain env
 * (b4m-core/resource manifest), exactly as on Kubernetes. That is why this service sets RENDER_JOB_QUEUE and
 * friends as environment instead of linking: links would only add SST_RESOURCE_* entries the shim never reads,
 * and their sqs:* / s3:* grants are wider than the worker needs.
 *
 * Scales on renderJobQueue depth (one render per task): out while jobs wait, back to the floor after the queue
 * has been empty, with nothing in flight, for SCALE_IN_IDLE_MINUTES. The worker also sets ECS task scale-in
 * protection while it renders.
 *
 * Image: the deploy pipeline builds the Dockerfile and exports the URI as RENDER_WORKER_IMAGE, per
 * infra/deploy-contract.json. Without it (local `sst dev`, personal deploys, or a CI deploy before the pipeline has
 * built the image) the service is skipped with a warning; render jobs then wait in the queue until the generation
 * job sweep times them out.
 */
const renderWorkerImage = process.env.RENDER_WORKER_IMAGE;
if (process.env.CI === 'true' && !renderWorkerImage) {
  console.warn(
    'RENDER_WORKER_IMAGE is not set; skipping the Studio render worker service (render jobs wait in the queue ' +
      'until the generation job sweep times them out).'
  );
}
const enabled = !$dev && !!renderWorkerImage;

// 2 vCPU needs 4-16 GB on Fargate. ffmpeg uses every core it is given.
const RENDER_WORKER_CPU = '2 vCPU';
const RENDER_WORKER_MEMORY = '4 GB';
// Inputs, intermediates and the output MP4 all sit on local disk during a render.
const RENDER_WORKER_STORAGE = '50 GB';
const RENDER_WORKER_MAX_TASKS = 5;
// Warm floor for demos; 0 scales to zero when idle.
const RENDER_WORKER_MIN_TASKS = Number(process.env.RENDER_WORKER_MIN_TASKS || '0');
if (
  !Number.isInteger(RENDER_WORKER_MIN_TASKS) ||
  RENDER_WORKER_MIN_TASKS < 0 ||
  RENDER_WORKER_MIN_TASKS > RENDER_WORKER_MAX_TASKS
) {
  throw new Error(
    `RENDER_WORKER_MIN_TASKS must be an integer from 0 to ${RENDER_WORKER_MAX_TASKS} (got "${process.env.RENDER_WORKER_MIN_TASKS}").`
  );
}
// Fargate's maximum. After SIGTERM the worker gives its render RENDER_DRAIN_GRACE_MS, then hands the message back;
// the remaining ~30s covers that hand-back and the final log flush before SIGKILL.
const STOP_TIMEOUT_SECONDS = 120;
const RENDER_DRAIN_GRACE_MS = 90_000;
const SCALE_IN_IDLE_MINUTES = 10;

function createRenderWorker() {
  // Raw env value: the shim reads MONGODB_URI as plain env, not as an SST_RESOURCE_* JSON document.
  const mongoSecret = ecsEnvSecret('RenderWorker', 'MONGODB_URI', secrets.MONGODB_URI.value);
  const partition = aws.getPartitionOutput().partition;
  const region = aws.getRegionOutput().name;
  const accountId = aws.getCallerIdentityOutput().accountId;

  const service = new sst.aws.Service('RenderWorker', {
    cluster,
    image: renderWorkerImage!,
    cpu: RENDER_WORKER_CPU,
    memory: RENDER_WORKER_MEMORY,
    storage: RENDER_WORKER_STORAGE,
    // Same policy as ChatCompletion (infra/chatCompletionCapacity.ts): Spot on previews only. An interrupted
    // render is redelivered after the visibility timeout and the worker is idempotent per job.
    capacity: isPreviewStage ? 'spot' : undefined,
    // Only the queue alarms below move desired count; SST's default CPU/memory tracking would fight them.
    scaling: {
      min: RENDER_WORKER_MIN_TASKS,
      max: RENDER_WORKER_MAX_TASKS,
      cpuUtilization: false,
      memoryUtilization: false,
    },
    ssm: mongoSecret.ssm,
    permissions: [
      {
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'],
        resources: [renderJobQueue.arn],
      },
      { actions: ['sqs:SendMessage'], resources: [generationJobQueue.arn] },
      { actions: ['s3:GetObject'], resources: [$interpolate`${fabFileBucket.arn}/*`] },
      { actions: ['s3:GetObject', 's3:PutObject'], resources: [$interpolate`${generatedImagesBucket.arn}/*`] },
      // Without ListBucket a read of a status object that does not exist yet returns AccessDenied instead of
      // NoSuchKey, and the worker treats only the latter as "no status".
      { actions: ['s3:ListBucket'], resources: [generatedImagesBucket.arn] },
      // Scale-in protection while a render runs, set through the ECS agent endpoint with the task role.
      {
        actions: ['ecs:UpdateTaskProtection'],
        resources: [$interpolate`arn:${partition}:ecs:${region}:${accountId}:task/${cluster.nodes.cluster.name}/*`],
      },
    ],
    environment: {
      APP_NAME: $app.name,
      APP_STAGE: $app.stage,
      AWS_REGION: region,
      RENDER_JOB_QUEUE: renderJobQueue.url,
      GENERATION_JOB_QUEUE: generationJobQueue.url,
      FAB_FILE_BUCKET: fabFileBucket.name,
      GENERATED_IMAGES_BUCKET: generatedImagesBucket.name,
      RENDER_DRAIN_GRACE_MS: String(RENDER_DRAIN_GRACE_MS),
      ECS_SECRETS_VERSION: ecsSecretsVersion(mongoSecret),
    },
    logging: {
      retention: STAGE_LOG_RETENTION,
    },
    transform: {
      // SST's Service args don't expose the container stopTimeout; without this ECS kills after 30s.
      taskDefinition: args => {
        args.containerDefinitions = $output(args.containerDefinitions).apply(json => {
          const definitions = JSON.parse(json) as Array<Record<string, unknown>>;
          for (const definition of definitions) definition.stopTimeout = STOP_TIMEOUT_SECONDS;
          return JSON.stringify(definitions);
        });
      },
      // Application Auto Scaling owns desired count; a redeploy must not reset it to the floor mid-render.
      service: (_args, opts) => {
        opts.ignoreChanges = ['desiredCount'];
      },
    },
  });

  createQueueDepthScaling(service);
  return service;
}

/**
 * Step scaling on renderJobQueue depth. SQS publishes these metrics once a minute while the queue is active, so
 * the first task of a burst starts within a few minutes of the first message.
 */
function createQueueDepthScaling(service: sst.aws.Service) {
  const target = service.nodes.autoScalingTarget;
  const queueName = renderJobQueue.nodes.queue.name;
  const alarmPrefix = `${$app.name}-${$app.stage}-render-worker`;

  // One render per task, so add roughly one task per waiting job. Intervals are relative to the threshold of 1;
  // the alarm re-invokes the policy every minute it stays in ALARM, and the max caps the total.
  const scaleOut = new aws.appautoscaling.Policy('RenderWorkerScaleOut', {
    serviceNamespace: target.serviceNamespace,
    scalableDimension: target.scalableDimension,
    resourceId: target.resourceId,
    policyType: 'StepScaling',
    stepScalingPolicyConfiguration: {
      adjustmentType: 'ChangeInCapacity',
      // Longer than a task's cold start (large image pull plus 50 GB ephemeral storage), so jobs a new task
      // is about to take are not counted twice.
      cooldown: 300,
      metricAggregationType: 'Maximum',
      stepAdjustments: [
        { metricIntervalLowerBound: '0', metricIntervalUpperBound: '1', scalingAdjustment: 1 },
        { metricIntervalLowerBound: '1', metricIntervalUpperBound: '2', scalingAdjustment: 2 },
        { metricIntervalLowerBound: '2', metricIntervalUpperBound: '3', scalingAdjustment: 3 },
        { metricIntervalLowerBound: '3', scalingAdjustment: RENDER_WORKER_MAX_TASKS },
      ],
    },
  });

  new aws.cloudwatch.MetricAlarm('RenderWorkerQueueBacklog', {
    name: `${alarmPrefix}-backlog`,
    alarmDescription: 'Scales the Studio render worker out while render jobs wait in renderJobQueue.',
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    dimensions: { QueueName: queueName },
    statistic: 'Maximum',
    period: 60,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    treatMissingData: 'notBreaching',
    alarmActions: [scaleOut.arn],
  });

  // Back to the floor only when nothing is waiting or in flight, so a running render keeps its task.
  const scaleIn = new aws.appautoscaling.Policy('RenderWorkerScaleIn', {
    serviceNamespace: target.serviceNamespace,
    scalableDimension: target.scalableDimension,
    resourceId: target.resourceId,
    policyType: 'StepScaling',
    stepScalingPolicyConfiguration: {
      adjustmentType: 'ExactCapacity',
      cooldown: 60,
      metricAggregationType: 'Maximum',
      stepAdjustments: [{ metricIntervalUpperBound: '0', scalingAdjustment: RENDER_WORKER_MIN_TASKS }],
    },
  });

  new aws.cloudwatch.MetricAlarm('RenderWorkerQueueIdle', {
    name: `${alarmPrefix}-idle`,
    alarmDescription: `Scales the Studio render worker to its floor after ${SCALE_IN_IDLE_MINUTES} minutes with renderJobQueue empty.`,
    comparisonOperator: 'LessThanOrEqualToThreshold',
    evaluationPeriods: SCALE_IN_IDLE_MINUTES,
    threshold: 0,
    // SQS stops publishing for a long-idle queue; no data means no work.
    treatMissingData: 'breaching',
    alarmActions: [scaleIn.arn],
    metricQueries: [
      {
        id: 'visible',
        returnData: false,
        metric: {
          namespace: 'AWS/SQS',
          metricName: 'ApproximateNumberOfMessagesVisible',
          dimensions: { QueueName: queueName },
          stat: 'Maximum',
          period: 60,
        },
      },
      {
        id: 'inFlight',
        returnData: false,
        metric: {
          namespace: 'AWS/SQS',
          metricName: 'ApproximateNumberOfMessagesNotVisible',
          dimensions: { QueueName: queueName },
          stat: 'Maximum',
          period: 60,
        },
      },
      {
        id: 'outstanding',
        returnData: true,
        label: 'Visible + in flight',
        expression: 'visible + inFlight',
      },
    ],
  });

  // A job waiting this long means no task is picking work up (stuck scale-out, crash loop). Notifies on monitored
  // stages only, where dlqAlarmTopic exists.
  if (dlqAlarmTopic) {
    new aws.cloudwatch.MetricAlarm('RenderWorkerQueueAge', {
      name: `${alarmPrefix}-queue-age`,
      alarmDescription:
        'The oldest job in renderJobQueue has waited over 15 minutes; the render worker is not draining it.',
      namespace: 'AWS/SQS',
      metricName: 'ApproximateAgeOfOldestMessage',
      dimensions: { QueueName: queueName },
      statistic: 'Maximum',
      period: 300,
      evaluationPeriods: 1,
      threshold: 900,
      comparisonOperator: 'GreaterThanThreshold',
      treatMissingData: 'notBreaching',
      alarmActions: [dlqAlarmTopic.arn],
      tags: { Application: 'StudioRender', Severity: 'Medium' },
    });
  }
}

export const renderWorker = enabled ? createRenderWorker() : undefined;
