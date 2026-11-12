import { createHash } from 'node:crypto';
import { DescribeAlarmsCommand, CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { GetQueueUrlCommand, ListDeadLetterSourceQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { connectDB, dlqTriageDeliveryRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getDlqByLabel } from '@bike4mind/server-utils/utils/dlqRegistry';
import { receiveFromQueue, getQueueAttributes } from '@bike4mind/server-utils/utils/sqs';
import { triageDlqMessage, loadDlqTriageConfig } from '@server/admin/dlq/triage';
import { Resource } from 'sst';
import { buildDlqTriageSection } from './dlqTriageMessage';

export async function collectDlqTriage(alarmName: string, appUrl?: string) {
  const deadline = Date.now() + 15_000;
  const prefix = `${Resource.App.name}-${Resource.App.stage}-dlq-`;
  if (!alarmName.startsWith(prefix)) return null;
  const label = alarmName.slice(prefix.length).replace(/-(messages|age)$/, '');
  const entry = getDlqByLabel(label);
  if (!entry) return null;
  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), new Logger());
  const config = await loadDlqTriageConfig();
  if (!config.enabled || config.features.dlqTriage.mode === 'off' || config.dlqQueueModes[label] === 'off') return null;
  const alarms = await new CloudWatchClient({}).send(new DescribeAlarmsCommand({ AlarmNames: [alarmName] }));
  const alarm = alarms.MetricAlarms?.[0];
  const dimensions = [
    ...(alarm?.Dimensions ?? []),
    ...(alarm?.Metrics?.flatMap(metric => metric.MetricStat?.Metric?.Dimensions ?? []) ?? []),
  ];
  const queueName = dimensions?.find(dimension => dimension.Name === 'QueueName')?.Value;
  if (!queueName) return null;
  const sqs = new SQSClient({});
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) return null;
  const sources = await sqs.send(new ListDeadLetterSourceQueuesCommand({ QueueUrl }));
  const sourceQueueName =
    sources.queueUrls?.length === 1 ? (new URL(sources.queueUrls[0]).pathname.split('/').pop() ?? null) : null;
  const attributes = await getQueueAttributes(QueueUrl);
  const suggestions = new Map<string, NonNullable<Awaited<ReturnType<typeof triageDlqMessage>>>>();
  const seen = new Set<string>();
  // Visibility stays zero: triage must not reserve work or delay an admin action.
  for (let page = 0; page < 10; page++) {
    if (Date.now() >= deadline) break;
    const messages = await receiveFromQueue(QueueUrl, 10, 0);
    let fresh = 0;
    for (const message of messages) {
      if (Date.now() >= deadline) break;
      if (!message.MessageId || seen.has(message.MessageId)) continue;
      seen.add(message.MessageId);
      fresh++;
      const suggestion = await triageDlqMessage(label, message.MessageId, {
        sentTimestamp: message.Attributes?.SentTimestamp,
        retentionSeconds: attributes.messageRetentionSeconds,
        sourceQueueName,
      });
      if (suggestion?.status === 'pending') suggestions.set(message.MessageId, suggestion);
    }
    if (!fresh || messages.length === 0) break;
  }
  if (!suggestions.size) return null;
  const claimed = [];
  for (const suggestion of suggestions.values()) {
    if (await dlqTriageDeliveryRepository.claim(`dlq-suggestion:${suggestion.id}`)) claimed.push(suggestion);
  }
  if (!claimed.length) return null;
  const ids = claimed.map(suggestion => suggestion.id).sort();
  const key = `dlq-triage:${label}:${createHash('sha256').update(ids.join(':')).digest('hex')}`;
  if (!(await dlqTriageDeliveryRepository.claim(key))) return null;
  return { key, suggestionIds: ids, section: buildDlqTriageSection(label, claimed, appUrl) };
}

export async function finishDlqTriageDelivery(triage: { key: string; suggestionIds: string[] }, delivered: boolean) {
  if (delivered) {
    await dlqTriageDeliveryRepository.delivered(triage.key);
    for (const id of triage.suggestionIds) await dlqTriageDeliveryRepository.delivered(`dlq-suggestion:${id}`);
  }
}
