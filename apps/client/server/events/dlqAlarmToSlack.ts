/**
 * DLQ Alarm -> Slack Notifier
 *
 * Subscribes to the shared DLQ alarm SNS topic and posts a formatted
 * message to the error-reporting Slack channel whenever a DLQ alarm
 * transitions to ALARM state.
 *
 * Only ALARM transitions are reported; OK (resolved) transitions are
 * suppressed to avoid channel noise.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    let alarm: CloudWatchAlarmPayload;
    try {
      alarm = JSON.parse(record.Sns.Message) as CloudWatchAlarmPayload;
    } catch {
      // Not a CloudWatch alarm payload, skip silently
      continue;
    }

    // Only notify on ALARM state; suppress OK (resolved) to reduce noise
    if (alarm.NewStateValue !== 'ALARM') continue;

    const text = [
      `🚨 *DLQ Alarm — ${alarm.AlarmName}*`,
      alarm.AlarmDescription ?? '',
      `Reason: ${alarm.NewStateReason}`,
      `Time: ${alarm.StateChangeTime}`,
      `Stage: ${Resource.App.stage}`,
    ].join('\n');

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
