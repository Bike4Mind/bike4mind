/**
 * WAF Alarm -> Slack Notifier
 *
 * Subscribes to the WAF alarm SNS topic and posts a plain-English message to Slack.
 * Nothing here is WAF-specific beyond being the subscriber for that topic; formatting
 * is shared with the other alarm relays.
 *
 * ALARM transitions get the full explanation; OK (resolved) transitions are posted
 * as a short resolved line. INSUFFICIENT_DATA is skipped.
 * Alarms go to SLACK_ALARMS_WEBHOOK_URL when set, otherwise the error-reporting channel.
 * Production page-level alarms carry the mention token from the per-stage SSM parameter.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

import {
  appUrlFromEnv,
  formatAlarmSlackMessage,
  isCloudWatchAlarm,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
} from './alarmSlackMessage';
import { readAlarmMention } from './alarmSlackMention';

export const handler = async (event: SNSEvent): Promise<void> => {
  const options = { appUrl: appUrlFromEnv(), mention: await readAlarmMention() };
  for (const record of event.Records) {
    let payload: unknown;
    try {
      payload = JSON.parse(record.Sns.Message);
    } catch {
      // Not a CloudWatch alarm payload - skip silently
      continue;
    }
    if (!isCloudWatchAlarm(payload)) continue;

    const message = formatAlarmSlackMessage(payload, Resource.App.stage, options);
    if (!message) continue;

    await postAlarmToSlack(resolveAlarmWebhookUrl(Resource), message);
  }
};
