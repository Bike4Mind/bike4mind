/**
 * Service Health -> Slack Notifier
 *
 * Fans two different signals about long-running ECS services into Slack
 * (SLACK_ALARMS_WEBHOOK_URL when set, otherwise the error-reporting channel),
 * both arriving on one SNS topic:
 *
 *  1. A CloudWatch "no running tasks" alarm (see infra/serviceHealthAlarms.ts).
 *  2. An ECS Task State Change event forwarded by EventBridge, filtered to
 *     stopCode=TaskFailedToStart. This one carries the actual reason a task could
 *     not start (denied image pull, missing secret), which the alarm cannot.
 *
 * The two are deliberately complementary: the event fires within seconds but only
 * when ECS actually attempts a start, while the alarm catches a service sitting at
 * zero tasks for any reason at all. Alarm ALARM transitions get the full explanation and OK
 * (resolved) transitions a short resolved line; INSUFFICIENT_DATA is skipped.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

import {
  appUrlFromEnv,
  composeAlarmMessage,
  escapeMrkdwn,
  formatAlarmSlackMessage,
  isCloudWatchAlarm,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
  type FormatOptions,
  type SlackAlarmMessage,
} from './alarmSlackMessage';
import { readAlarmMention } from './alarmSlackMention';

/** The subset of an EventBridge ECS Task State Change event this handler reports on. */
interface EcsTaskStateChangeEvent {
  'detail-type': 'ECS Task State Change';
  detail?: {
    /** e.g. "service:subscriberFanoutV2" - identifies which service the task belonged to. */
    group?: string;
    stopCode?: string;
    stoppedReason?: string;
    taskArn?: string;
    containers?: { name?: string; reason?: string }[];
  };
}

/**
 * The only stop code this handler reports. The EventBridge rule already filters on it, so this
 * re-check is redundant today and deliberately so: it keeps the "Failed To Start" heading true by
 * construction, so broadening the rule later cannot silently relabel an ordinary stop as a startup
 * failure.
 *
 * Reporting every stop code instead would be worse, not more general. `UserInitiated` and
 * `ServiceSchedulerInitiated` fire on every routine deploy, so a broadened rule would turn this
 * channel into deploy noise and the alarms would stop being read. Widening the contract is a
 * deliberate act: extend this constant and give each code its own heading.
 */
const REPORTED_STOP_CODE = 'TaskFailedToStart';

function isEcsTaskStateChange(payload: unknown): payload is EcsTaskStateChangeEvent {
  return (payload as EcsTaskStateChangeEvent)?.['detail-type'] === 'ECS Task State Change';
}

/** Returns the Slack message for a payload, or null when it should not be reported. */
function formatMessage(payload: unknown, stage: string, options: FormatOptions): SlackAlarmMessage | null {
  if (isCloudWatchAlarm(payload)) return formatAlarmSlackMessage(payload, stage, options);

  if (isEcsTaskStateChange(payload)) {
    const detail = payload.detail ?? {};
    if (detail.stopCode !== REPORTED_STOP_CODE) return null;
    // The container-level reason is where CannotPullContainerError and friends land;
    // the task-level stoppedReason is often just a generic wrapper.
    const containerReason = detail.containers?.find(c => c.reason)?.reason;
    const service = detail.group ?? 'unknown service';
    const reason = containerReason ?? detail.stoppedReason ?? 'not reported';
    return composeAlarmMessage({
      stage,
      level: 'page',
      title: `A background service failed to start: ${service}`,
      mention: options.mention,
      sections: [
        `*Reason*\n${escapeMrkdwn(reason)}`,
        `*Task*\n${escapeMrkdwn(detail.taskArn ?? 'unknown')}`,
        '*What to do*\nCheck the service events in ECS; the reason above is usually enough to name the fix (image pull, missing secret).',
      ],
      context: [escapeMrkdwn(stage), 'level page', 'ecs task failed to start'],
      summary: reason,
    });
  }

  return null;
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const options: FormatOptions = { appUrl: appUrlFromEnv(), mention: await readAlarmMention() };
  for (const record of event.Records) {
    let payload: unknown;
    try {
      payload = JSON.parse(record.Sns.Message);
    } catch {
      // Neither an alarm nor an EventBridge event, skip silently
      continue;
    }

    const message = formatMessage(payload, Resource.App.stage, options);
    if (!message) continue;

    await postAlarmToSlack(resolveAlarmWebhookUrl(Resource), message);
  }
};
