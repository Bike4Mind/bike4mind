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
import { subscriberFanout } from './subscriberFanout';

const services: Record<PreviewSleepLabel, { id: string; service: sst.aws.Service }> = {
  'chat-completion': { id: 'ChatCompletion', service: chatCompletion },
  'subscriber-fanout': { id: 'SubscriberFanout', service: subscriberFanout },
};

// Scheduled min/max changes are not drift Pulumi reverts, so a deploy during the sleep window
// leaves the services asleep until the wake schedule (or the in-app wake) runs.
// nodes.autoScalingTarget throws under `sst dev`, hence the $dev guard.
if (isPreviewStage && !$dev) {
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
