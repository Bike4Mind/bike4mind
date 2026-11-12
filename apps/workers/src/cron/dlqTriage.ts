import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';
import { collectDlqTriage, finishDlqTriageDelivery } from '../events/dlqTriage';
import { appUrlFromEnv, postAlarmToSlack, resolveAlarmWebhookUrl } from '../events/alarmSlackMessage';

export async function handler() {
  let nextToken: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await new CloudWatchClient({}).send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: `${Resource.App.name}-${Resource.App.stage}-dlq-`,
        NextToken: nextToken,
      })
    );
    for (const alarm of response.MetricAlarms ?? []) {
      if (!alarm.AlarmName) continue;
      const queueKey = alarm.AlarmName.replace(/-(messages|age)$/, '');
      if (seen.has(queueKey)) continue;
      seen.add(queueKey);
      const triage = await collectDlqTriage(alarm.AlarmName, appUrlFromEnv());
      if (!triage) continue;
      const result = await postAlarmToSlack(
        resolveAlarmWebhookUrl(Resource, 'jobs'),
        {
          text: triage.section,
          blocks: [],
        },
        { atMostOnce: true }
      );
      await finishDlqTriageDelivery(triage, result.state === 'delivered');
    }
    nextToken = response.NextToken;
  } while (nextToken);
}
