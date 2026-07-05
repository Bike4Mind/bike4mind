/**
 * Posts a CloudWatch alarm SNS message to the error-reporting Slack channel.
 * Generic across alarm topics - the message is built from the alarm's own name/description.
 * Only ALARM transitions are reported; OK and INSUFFICIENT_DATA are suppressed to avoid noise.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

interface CloudWatchAlarmPayload {
  AlarmName: string;
  AlarmDescription: string;
  NewStateValue: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  OldStateValue: string;
  NewStateReason: string;
  StateChangeTime: string;
  Region: string;
}

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    let alarm: CloudWatchAlarmPayload;
    try {
      alarm = JSON.parse(record.Sns.Message) as CloudWatchAlarmPayload;
    } catch {
      // Not a CloudWatch alarm payload, skip silently
      continue;
    }

    // Only notify on ALARM state; suppress OK (resolved) and INSUFFICIENT_DATA to reduce noise
    if (alarm.NewStateValue !== 'ALARM') continue;

    const text = [
      `🚨 *CloudWatch Alarm — ${alarm.AlarmName}*`,
      alarm.AlarmDescription,
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
