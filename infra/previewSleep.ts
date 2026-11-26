import { chatCompletion } from './chatCompletion';
import { isPreviewStage } from './constants';
import {
  PREVIEW_ASLEEP,
  PREVIEW_SLEEP_CRON,
  PREVIEW_SLEEP_TIMEZONE,
  PREVIEW_WAKE_CRON,
  previewSleepTargets,
  type PreviewSleepLabel,
} from './previewSleepConfig';
import { isServiceHealthMonitoredStage } from './serviceHealthAlarms';
import { subscriberFanout } from './subscriberFanout';

const services: Record<PreviewSleepLabel, { id: string; service: sst.aws.Service }> = {
  'chat-completion': { id: 'ChatCompletion', service: chatCompletion },
  'subscriber-fanout': { id: 'SubscriberFanout', service: subscriberFanout },
};

// The no-tasks alarms in serviceHealthAlarms.ts read zero tasks as an outage, so a preview that
// opts into monitoring (ENABLE_MONITORING) never sleeps.
const previewSleepEnabled = isPreviewStage && !isServiceHealthMonitoredStage && !$dev;

// Scheduled min/max changes are not drift Pulumi reverts, so a deploy during the sleep window
// leaves the services asleep until the wake schedule (or the in-app wake) runs.
// nodes.autoScalingTarget throws under `sst dev`, hence the $dev guard.
if (previewSleepEnabled) {
  for (const { label, awake } of previewSleepTargets()) {
    const { id, service } = services[label];
    const target = service.nodes.autoScalingTarget;
    const shared = {
      serviceNamespace: target.serviceNamespace,
      scalableDimension: target.scalableDimension,
      resourceId: target.resourceId,
      timezone: PREVIEW_SLEEP_TIMEZONE,
    };
    new aws.appautoscaling.ScheduledAction(`${id}PreviewSleep`, {
      ...shared,
      name: `${$app.stage}-${label}-preview-sleep`,
      schedule: PREVIEW_SLEEP_CRON,
      scalableTargetAction: { minCapacity: PREVIEW_ASLEEP.min, maxCapacity: PREVIEW_ASLEEP.max },
    });
    new aws.appautoscaling.ScheduledAction(`${id}PreviewWake`, {
      ...shared,
      name: `${$app.stage}-${label}-preview-wake`,
      schedule: PREVIEW_WAKE_CRON,
      scalableTargetAction: { minCapacity: awake.min, maxCapacity: awake.max },
    });
  }
}

const ecsServiceArn = (resourceId: $util.Input<string>) =>
  $interpolate`arn:${aws.getPartitionOutput().partition}:ecs:${aws.getRegionOutput().region}:${aws.getCallerIdentityOutput().accountId}:${resourceId}`;

/**
 * Wiring for the web Lambda's wake route (apps/client/server/previewSleep). Empty off-preview, so
 * the route sees no PREVIEW_SLEEP_TARGETS and 404s; the grants reach only this stage's own targets.
 */
export const previewSleepForWeb = previewSleepEnabled
  ? (() => {
      const targets = previewSleepTargets().map(({ label, awake }) => ({
        label,
        awake,
        target: services[label].service.nodes.autoScalingTarget,
      }));
      return {
        environment: {
          PREVIEW_SLEEP_ENABLED: 'true',
          NEXT_PUBLIC_PREVIEW_SLEEP_ENABLED: 'true',
          PREVIEW_SLEEP_TARGETS: $jsonStringify(
            targets.map(({ label, awake, target }) => ({
              label,
              resourceId: target.resourceId,
              min: awake.min,
              max: awake.max,
            }))
          ),
        },
        permissions: [
          {
            actions: ['application-autoscaling:RegisterScalableTarget'],
            resources: targets.map(({ target }) => target.arn),
          },
          // Read-only, and AWS supports no resource scope for it.
          { actions: ['application-autoscaling:DescribeScalableTargets'], resources: ['*'] },
          // Same: read-only with no resource scope. The status route reads it to see a woken task serve.
          { actions: ['elasticloadbalancing:DescribeTargetHealth'], resources: ['*'] },
          // RegisterScalableTarget on an ECS target also checks these against the service.
          {
            actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
            resources: targets.map(({ target }) => ecsServiceArn(target.resourceId)),
          },
        ],
      };
    })()
  : { environment: {}, permissions: [] };
