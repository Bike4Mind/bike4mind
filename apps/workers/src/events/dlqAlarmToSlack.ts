/**
 * Alarm -> Slack Notifier
 *
 * Subscribes to the shared alarm SNS topic (originally DLQ-only, now also carries
 * non-DLQ operational alarms such as feedbackDeliveryFailures - see infra/alarms.ts)
 * and posts a plain-English message to Slack when a subscribed alarm changes state.
 *
 * ALARM transitions get the full explanation; an OK that follows an ALARM is posted as a short
 * resolved line. INSUFFICIENT_DATA, and an OK that follows it, are skipped.
 * Cost alarms go to SLACK_COST_ALARMS_WEBHOOK_URL when set; everything else, and cost alarms
 * without it, go to SLACK_ALARMS_WEBHOOK_URL when set, otherwise the error-reporting channel.
 * Production page-level alarms carry the mention token from the per-stage SSM parameter.
 * Alarms whose catalog entry asks for a detail get it loaded first (young-account spend lists
 * the accounts behind the breach; provider spend breaks the window down by account age, source,
 * model and account; a refused-request burst names its top IPs, paths and signup accounts); a
 * failed load posts the alarm with a note instead.
 */

import type { SNSEvent } from 'aws-lambda';
import { Resource } from 'sst';

import {
  alarmCatalogEntry,
  alarmCategory,
  appUrlFromEnv,
  formatAlarmSlackMessage,
  isCloudWatchAlarm,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
  type FormatOptions,
} from './alarmSlackMessage';
import { readAlarmMention } from './alarmSlackMention';
import { providerSpendSection } from './providerSpendDetail';
import { refusedRequestBurstSection } from './refusedRequestBurstDetail';
import { youngAccountSpendSection } from './youngAccountSpendDetail';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';
import { collectDlqTriage, finishDlqTriageDelivery, canNotifyDlqTriage } from './dlqTriage';
import { Logger } from '@bike4mind/observability';

async function loadDetails(
  alarm: CloudWatchAlarmPayload,
  stage: string,
  appUrl: string | undefined
): Promise<string[]> {
  if (alarm.NewStateValue !== 'ALARM') return [];
  const detail = alarmCatalogEntry(alarm, stage)?.detail;
  if (detail === 'young-account-spend') return [await youngAccountSpendSection(alarm, { appUrl })];
  if (detail === 'provider-spend') return [await providerSpendSection(alarm, { appUrl })];
  if (detail === 'refused-request-burst') return [await refusedRequestBurstSection(alarm, { appUrl })];
  return [];
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const options: FormatOptions = { appUrl: appUrlFromEnv(), mention: await readAlarmMention() };
  for (const record of event.Records) {
    let payload: unknown;
    try {
      payload = JSON.parse(record.Sns.Message);
    } catch {
      // Not a CloudWatch alarm payload, skip silently
      continue;
    }
    if (!isCloudWatchAlarm(payload)) continue;

    // Formatted once without details to learn whether this stage posts the alarm at all, so a
    // dropped alarm never pays for a log query.
    const stage = Resource.App.stage;
    const bare = formatAlarmSlackMessage(payload, stage, options);
    if (!bare) continue;
    const details = await loadDetails(payload, stage, options.appUrl);
    let triage =
      payload.NewStateValue === 'ALARM'
        ? await collectDlqTriage(payload.AlarmName, options.appUrl).catch(() => {
            Logger.warn('[DLQ Triage] Recommendation unavailable; forwarding base alarm');
            return null;
          })
        : null;
    if (triage && !(await canNotifyDlqTriage(triage))) triage = null;
    if (triage) details.push(triage.section);
    const message =
      details.length > 0 ? (formatAlarmSlackMessage(payload, stage, { ...options, details }) ?? bare) : bare;

    const delivery = await postAlarmToSlack(resolveAlarmWebhookUrl(Resource, alarmCategory(payload, stage)), message, {
      atMostOnce: !!triage,
    });
    if (triage) await finishDlqTriageDelivery(triage, delivery.state === 'delivered');
    if (delivery.state !== 'delivered') {
      Logger.warn('[DLQ Triage] Slack delivery unconfirmed; retrying the base alarm without recommendations');
      throw new Error('Alarm Slack delivery was not confirmed');
    }
  }
};
