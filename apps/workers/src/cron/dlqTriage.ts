import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';
import {
  collectDlqTriage,
  finishDlqTriageDelivery,
  canNotifyDlqTriage,
  releaseDlqTriageDelivery,
} from '../events/dlqTriage';
import { withinTriageBudget } from '../events/dlqTriageBudget';
import { Logger } from '@bike4mind/observability';
import { appUrlFromEnv, postAlarmToSlack, resolveAlarmWebhookUrl } from '../events/alarmSlackMessage';

export async function handler() {
  const deadline = Date.now() + 240_000;
  const cloudwatch = new CloudWatchClient({ maxAttempts: 1 });
  let nextToken: string | undefined;
  const seen = new Set<string>();
  let failed = 0;
  do {
    if (Date.now() >= deadline) throw new Error('DLQ triage sweep stopped with partial queue coverage');
    const response = await cloudwatch.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: `${Resource.App.name}-${Resource.App.stage}-dlq-`,
        NextToken: nextToken,
      }),
      { abortSignal: AbortSignal.timeout(3_000) }
    );
    for (const alarm of response.MetricAlarms ?? []) {
      if (!alarm.AlarmName) continue;
      if (Date.now() >= deadline) throw new Error('DLQ triage sweep stopped with partial queue coverage');
      const queueKey = alarm.AlarmName.replace(/-(messages|age)$/, '');
      if (seen.has(queueKey)) continue;
      seen.add(queueKey);
      try {
        const triage = await collectDlqTriage(alarm.AlarmName, appUrlFromEnv(), deadline);
        if (!triage || !(await canNotifyDlqTriage(triage))) continue;
        if (Date.now() >= deadline) {
          await releaseDlqTriageDelivery(triage);
          throw new Error('DLQ triage deadline reached before notification');
        }
        const result = await withinTriageBudget(deadline, () =>
          postAlarmToSlack(
            resolveAlarmWebhookUrl(Resource, 'jobs'),
            { text: triage.section, blocks: [] },
            { atMostOnce: true }
          )
        );
        await finishDlqTriageDelivery(triage, result.state === 'delivered');
      } catch {
        failed++;
        Logger.warn('[DLQ Triage] Queue collection failed; continuing with remaining queues');
      }
    }
    nextToken = response.NextToken;
  } while (nextToken);
  Logger.log('[DLQ Triage] Sweep finished with sampled, not exhaustive, message coverage', { queues: seen.size });
  if (failed) throw new Error(`DLQ triage sweep failed for ${failed} queues`);
}
