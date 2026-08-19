/**
 * Service Health -> Slack Notifier
 *
 * Fans two different signals about long-running ECS services into the
 * error-reporting Slack channel, both arriving on one SNS topic:
 *
 *  1. A CloudWatch "no running tasks" alarm (see infra/serviceHealthAlarms.ts).
 *  2. An ECS Task State Change event forwarded by EventBridge, filtered to
 *     stopCode=TaskFailedToStart. This one carries the actual reason a task could
 *     not start (denied image pull, missing secret), which the alarm cannot.
 *
 * The two are deliberately complementary: the event fires within seconds but only
 * when ECS actually attempts a start, while the alarm catches a service sitting at
 * zero tasks for any reason at all. Only ALARM transitions are reported; OK
 * (resolved) transitions are suppressed to avoid channel noise.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

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

function isEcsTaskStateChange(payload: unknown): payload is EcsTaskStateChangeEvent {
  return (payload as EcsTaskStateChangeEvent)?.['detail-type'] === 'ECS Task State Change';
}

function isCloudWatchAlarm(payload: unknown): payload is CloudWatchAlarmPayload {
  return typeof (payload as CloudWatchAlarmPayload)?.NewStateValue === 'string';
}

/** Returns the Slack text for a payload, or null when it should not be reported. */
function formatMessage(payload: unknown, stage: string): string | null {
  if (isCloudWatchAlarm(payload)) {
    // Suppress OK (resolved) and INSUFFICIENT_DATA to reduce channel noise.
    if (payload.NewStateValue !== 'ALARM') return null;
    return [
      `🚨 *Service Down - ${payload.AlarmName}*`,
      payload.AlarmDescription ?? '',
      `Reason: ${payload.NewStateReason}`,
      `Time: ${payload.StateChangeTime}`,
      `Stage: ${stage}`,
    ].join('\n');
  }

  if (isEcsTaskStateChange(payload)) {
    const detail = payload.detail ?? {};
    // The container-level reason is where CannotPullContainerError and friends land;
    // the task-level stoppedReason is often just a generic wrapper.
    const containerReason = detail.containers?.find(c => c.reason)?.reason;
    return [
      `🚨 *ECS Task Failed To Start - ${detail.group ?? 'unknown service'}*`,
      `Stop code: ${detail.stopCode ?? 'unknown'}`,
      `Reason: ${containerReason ?? detail.stoppedReason ?? 'not reported'}`,
      `Task: ${detail.taskArn ?? 'unknown'}`,
      `Stage: ${stage}`,
    ].join('\n');
  }

  return null;
}

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    let payload: unknown;
    try {
      payload = JSON.parse(record.Sns.Message);
    } catch {
      // Neither an alarm nor an EventBridge event, skip silently
      continue;
    }

    const text = formatMessage(payload, Resource.App.stage);
    if (!text) continue;

    const resp = await fetch(Resource.SLACK_ERROR_REPORTING_WEBHOOK_URL.value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      throw new Error(`Slack webhook failed: ${resp.status} ${resp.statusText}`);
    }
  }
};
