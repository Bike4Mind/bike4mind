/**
 * WAF Alarm -> Slack Notifier
 *
 * Subscribes to the WAF alarm SNS topic and posts a plain-English message to Slack.
 * Nothing here is WAF-specific beyond being the subscriber for that topic; formatting
 * is shared with the other alarm relays.
 *
 * ALARM transitions get the full explanation; an OK that follows an ALARM is posted as a short
 * resolved line. INSUFFICIENT_DATA, and an OK that follows it, are skipped.
 * Routing is by category, the same as the general relay (see resolveAlarmWebhookUrl).
 * Production page-level alarms carry the mention token from the per-stage SSM parameter.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

import {
  alarmCategory,
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

    const stage = Resource.App.stage;
    const message = formatAlarmSlackMessage(payload, stage, options);
    if (!message) continue;

    await postAlarmToSlack(resolveAlarmWebhookUrl(Resource, alarmCategory(payload, stage)), message);
  }
};
