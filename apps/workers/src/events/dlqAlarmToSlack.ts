/**
 * Alarm -> Slack Notifier
 *
 * Subscribes to the shared alarm SNS topic (originally DLQ-only, now also carries
 * non-DLQ operational alarms such as feedbackDeliveryFailures - see infra/alarms.ts)
 * and posts a plain-English message to Slack when a subscribed alarm changes state.
 *
 * ALARM transitions get the full explanation; OK (resolved) transitions are posted
 * as a short resolved line. INSUFFICIENT_DATA is skipped.
 * Alarms go to SLACK_ALARMS_WEBHOOK_URL when set, otherwise the error-reporting channel.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

import {
  formatAlarmSlackMessage,
  isCloudWatchAlarm,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
} from './alarmSlackMessage';

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    let payload: unknown;
    try {
      payload = JSON.parse(record.Sns.Message);
    } catch {
      // Not a CloudWatch alarm payload, skip silently
      continue;
    }
    if (!isCloudWatchAlarm(payload)) continue;

    const message = formatAlarmSlackMessage(payload, Resource.App.stage);
    if (!message) continue;

    await postAlarmToSlack(resolveAlarmWebhookUrl(Resource), message);
  }
};
