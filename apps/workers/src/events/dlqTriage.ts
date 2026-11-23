import { createHash } from 'node:crypto';
import { DescribeAlarmsCommand, CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import {
  GetQueueUrlCommand,
  ListDeadLetterSourceQueuesCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { dlqTriageDeliveryRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { resolveConsumerLogs, settleWithinBudget } from '@bike4mind/server-utils/utils/dlqConsumerLogs';
import { describeDlqMessage, getDlqByLabel } from '@bike4mind/server-utils/utils/dlqRegistry';
import { triageDlqMessage, loadDlqTriageConfig } from '@bike4mind/server-utils/admin/dlq/triage';
import { Resource } from 'sst';
import { buildDlqTriageSection } from './dlqTriageMessage';
import { withinTriageBudget } from './dlqTriageBudget';
import { connectRelayDb } from './relayDb';

export async function collectDlqTriage(alarmName: string, appUrl?: string, runDeadline = Date.now() + 15_000) {
  const deadline = Math.min(runDeadline, Date.now() + 15_000);
  return withinTriageBudget(deadline, () => collect(alarmName, appUrl, deadline));
}

async function collect(alarmName: string, appUrl: string | undefined, deadline: number) {
  const request = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('DLQ triage deadline reached');
    return { abortSignal: AbortSignal.timeout(Math.min(3_000, remaining)) };
  };
  const prefix = `${Resource.App.name}-${Resource.App.stage}-dlq-`;
  if (!alarmName.startsWith(prefix)) return null;
  const label = alarmName.slice(prefix.length).replace(/-(messages|age)$/, '');
  const entry = getDlqByLabel(label);
  if (!entry) return null;
  await connectRelayDb(2_000);
  const config = await loadDlqTriageConfig();
  if (!config.enabled || config.features.dlqTriage.mode === 'off' || config.dlqQueueModes[label] === 'off') return null;
  const alarms = await new CloudWatchClient({ maxAttempts: 1 }).send(
    new DescribeAlarmsCommand({ AlarmNames: [alarmName] }),
    request()
  );
  const alarm = alarms.MetricAlarms?.[0];
  const dimensions = [
    ...(alarm?.Dimensions ?? []),
    ...(alarm?.Metrics?.flatMap(metric => metric.MetricStat?.Metric?.Dimensions ?? []) ?? []),
  ];
  const queueName = dimensions?.find(dimension => dimension.Name === 'QueueName')?.Value;
  if (!queueName) return null;
  const sqs = new SQSClient({ maxAttempts: 1 });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }), request());
  if (!QueueUrl) return null;
  const sources = await sqs.send(new ListDeadLetterSourceQueuesCommand({ QueueUrl }), request());
  const sourceQueueName =
    sources.queueUrls?.length === 1 ? (new URL(sources.queueUrls[0]).pathname.split('/').pop() ?? null) : null;
  const sourceQueueUrl = sources.queueUrls?.length === 1 ? sources.queueUrls[0] : null;
  const { Attributes: attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['MessageRetentionPeriod', 'ApproximateNumberOfMessages'],
    }),
    request()
  );
  if (sourceQueueUrl) {
    await settleWithinBudget(
      [resolveConsumerLogs(sourceQueueUrl)],
      Math.min(1_000, Math.max(0, deadline - Date.now()))
    );
  }
  // Spend at most half the remaining budget on log fallbacks so later messages still get sampled.
  const logFallbackDeadline = Date.now() + Math.max(0, deadline - Date.now()) / 2;
  const suggestions = new Map<string, NonNullable<Awaited<ReturnType<typeof triageDlqMessage>>>>();
  const seen = new Set<string>();
  // Visibility stays zero: triage must not reserve work or delay an admin action.
  for (let page = 0; page < 10; page++) {
    if (Date.now() >= deadline) break;
    const { Messages: messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 0,
        WaitTimeSeconds: 0,
        MessageSystemAttributeNames: ['SentTimestamp'],
      }),
      request()
    );
    let fresh = 0;
    for (const message of messages) {
      if (Date.now() >= deadline) break;
      if (!message.MessageId || seen.has(message.MessageId)) continue;
      seen.add(message.MessageId);
      fresh++;
      const suggestion = await triageDlqMessage(label, message.MessageId, {
        sentTimestamp: message.Attributes?.SentTimestamp,
        retentionSeconds: Number(attributes?.MessageRetentionPeriod) || undefined,
        sourceQueueName,
        sourceQueueUrl,
        entityPresent: describeDlqMessage(entry, message.Body) !== null,
        logFallbackDeadline,
      });
      if (suggestion?.status === 'pending') suggestions.set(message.MessageId, suggestion);
    }
    if (!fresh || messages.length === 0) break;
  }
  if (!suggestions.size) return null;
  if (!(await canNotifyDlqTriage({ queueLabel: label, suggestionIds: [] }))) return null;
  const claimed: Array<NonNullable<Awaited<ReturnType<typeof triageDlqMessage>>>> = [];
  const coverage = `Sampled ${seen.size} unique messages; queue reports approximately ${attributes?.ApproximateNumberOfMessages ?? 'unknown'} visible. Partial coverage: SQS sampling is not an inventory. Only new recommendations that fit this notification are shown.`;
  let ready = false;
  try {
    for (const suggestion of suggestions.values()) {
      if (Date.now() >= deadline) break;
      if (buildDlqTriageSection(label, [...claimed, suggestion], appUrl).length > 1_800) break;
      if (await dlqTriageDeliveryRepository.claim(`dlq-suggestion:${suggestion.id}`)) claimed.push(suggestion);
    }
    if (!claimed.length || Date.now() >= deadline) return null;
    const ids = claimed.map(suggestion => suggestion.id).sort();
    const key = `dlq-triage:${label}:${createHash('sha256').update(ids.join(':')).digest('hex')}`;
    ready = true;
    return {
      key,
      queueLabel: label,
      suggestionIds: ids,
      section: `${coverage} Showing ${claimed.length} of ${suggestions.size} pending sampled recommendations.\n${buildDlqTriageSection(label, claimed, appUrl)}`,
    };
  } finally {
    if (!ready) await releaseDlqTriageDelivery({ suggestionIds: claimed.map(suggestion => suggestion.id) });
  }
}

export async function releaseDlqTriageDelivery(triage: { suggestionIds: string[] }) {
  await withinTriageBudget(Date.now() + 2_000, () =>
    Promise.all(triage.suggestionIds.map(id => dlqTriageDeliveryRepository.release(`dlq-suggestion:${id}`)))
  ).catch(() => Logger.warn('[DLQ Triage] Could not release unsent notification claims'));
}

export async function canNotifyDlqTriage(triage: { queueLabel: string; suggestionIds: string[] }) {
  const allowed = await withinTriageBudget(Date.now() + 2_000, async () => {
    const config = await loadDlqTriageConfig();
    return (
      config.enabled &&
      ['recommend', 'act'].includes(config.features.dlqTriage.mode) &&
      config.dlqQueueModes[triage.queueLabel] !== 'off'
    );
  }).catch(() => false);
  if (!allowed) await releaseDlqTriageDelivery(triage);
  return allowed;
}

export async function finishDlqTriageDelivery(triage: { key: string; suggestionIds: string[] }, delivered: boolean) {
  if (delivered) {
    await withinTriageBudget(Date.now() + 2_000, () =>
      Promise.all([...triage.suggestionIds.map(id => dlqTriageDeliveryRepository.delivered(`dlq-suggestion:${id}`))])
    ).catch(() => Logger.warn('[DLQ Triage] Delivery state remains unconfirmed'));
  }
}
