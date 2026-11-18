import type { Message, MessageAttributeValue } from '@aws-sdk/client-sqs';
import type { DlqRecommendation } from '@bike4mind/common';
import { CONSUMER_LOGS_BUDGET_MS, settleWithinBudget, type ConsumerLogs } from './dlqConsumerLogs';
import { messageLogsUrl, recommendForDlqMessage, type DlqFailureRecord, type DlqLogsLink } from './dlqMessages';
import {
  describeDlqMessage,
  type DlqMessageEntity,
  type DlqStaleScope,
  type DlqStaleWhen,
  type RegisteredDlqDescriptor,
} from './dlqRegistry';
import { ARN_PARTITION, nextRunDueAt, parseScheduledEvent, resolveScheduleRule } from './dlqScheduleRule';

const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_ERROR_CODE_CHARS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURE_ARN = new RegExp(
  String.raw`^arn:${ARN_PARTITION}:(lambda|events):[a-z0-9-]+:\d{12}:[A-Za-z0-9:/_.+=,@-]+$`
);
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
// C0/C1 controls plus zero-width and bidi formatting characters (all Default_Ignorable).
const INVISIBLE_CHARS = /[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

export type DlqAttributedFailure = {
  errorCode: string;
  errorMessage: string;
  requestId?: string;
  ruleArn?: string;
  targetArn?: string;
  shape: 'lambda-async' | 'eventbridge';
};

export type DlqRowFailure = {
  errorMessage: string;
  category: DlqFailureRecord['category'];
  source: 'recorded' | 'attributes';
  errorCode?: string;
};

function cleanText(value: string, max: number): string {
  const cleaned = value.replace(LINE_BREAKS, ' ').replace(INVISIBLE_CHARS, '').trim();
  const chars = [...cleaned];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : cleaned;
}

function stringAttribute(attributes: Record<string, MessageAttributeValue>, name: string): string | undefined {
  const value = attributes[name]?.StringValue;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// Lambda's ErrorCode is the Invoke HTTP status; a function error (thrown, timed out) still returns 200.
function lambdaStatus(code: string | undefined): string | undefined {
  if (!code || !/^\d{3}$/.test(code.trim())) return code;
  return code.trim() === '200' ? 'Function error' : `HTTP ${code.trim()}`;
}

/**
 * Failure details the DLQ redrive itself attached to a message: Lambda async invocation
 * (ErrorCode HTTP status/ErrorMessage/RequestID) or an EventBridge target (ERROR_CODE/ERROR_MESSAGE/RULE_ARN/TARGET_ARN).
 * Values are attacker-influenced text, so they are cleaned, length-capped, and IDs/ARNs are format-checked.
 */
export function attributeFailure(message: Message): DlqAttributedFailure | undefined {
  const attributes = message.MessageAttributes ?? {};
  const lambda = {
    code: stringAttribute(attributes, 'ErrorCode'),
    message: stringAttribute(attributes, 'ErrorMessage'),
  };
  const eventBridge = {
    code: stringAttribute(attributes, 'ERROR_CODE'),
    message: stringAttribute(attributes, 'ERROR_MESSAGE'),
  };
  const shape =
    lambda.code || lambda.message ? 'lambda-async' : eventBridge.code || eventBridge.message ? 'eventbridge' : null;
  if (!shape) return undefined;

  const raw = shape === 'lambda-async' ? { ...lambda, code: lambdaStatus(lambda.code) } : eventBridge;
  const requestId = stringAttribute(attributes, 'RequestID');
  const ruleArn = stringAttribute(attributes, 'RULE_ARN');
  const targetArn = stringAttribute(attributes, 'TARGET_ARN');
  return {
    errorCode: cleanText(raw.code ?? '', MAX_ERROR_CODE_CHARS),
    errorMessage: cleanText(raw.message ?? '', MAX_ERROR_MESSAGE_CHARS),
    shape,
    ...(requestId && UUID.test(requestId) ? { requestId } : {}),
    ...(shape === 'eventbridge' && ruleArn && FAILURE_ARN.test(ruleArn) ? { ruleArn } : {}),
    ...(shape === 'eventbridge' && targetArn && FAILURE_ARN.test(targetArn) ? { targetArn } : {}),
  };
}

/** The entry's staleWhen when it covers this raw body; a body outside staleDetailTypes gets none. */
export function staleWhenForMessage(entry: DlqStaleScope, rawBody: string | undefined): DlqStaleWhen | undefined {
  if (!entry.staleWhen || !entry.staleDetailTypes) return entry.staleWhen;
  let detailType: unknown;
  try {
    detailType = (JSON.parse(rawBody ?? '') as Record<string, unknown> | null)?.['detail-type'];
  } catch {
    return undefined;
  }
  return typeof detailType === 'string' && entry.staleDetailTypes.includes(detailType) ? entry.staleWhen : undefined;
}

export type DlqMessageRow = {
  queueLabel: string;
  messageId: string;
  body: string;
  entity: DlqMessageEntity | null;
  sentTimestamp?: string;
  approximateReceiveCount?: string;
  approximateFirstReceiveTimestamp?: string;
  logsUrl: string | null;
  logsScope?: DlqLogsLink['scope'];
  failureLookupFailed?: true;
  failure?: DlqRowFailure;
  recommendation: DlqRecommendation;
};

export type DlqScheduleFacts = {
  scheduledAt: string;
  nextRunDueAt?: string;
  logTarget?: { functionName: string; region: string };
};

/**
 * Schedule facts per message ID for Scheduled Event bodies. A rule is looked up when the queue is flagged
 * superseded-schedule (for nextRunDueAt) or the message carries a Lambda RequestID (for the logs link
 * target). nextRunDueAt is set only when `messages` holds the whole queue (`queueDepth` known and reached;
 * it must count in-flight messages too, since a hidden copy may be the next run) and the next run of the same rule is not among them. Each rule is looked up once, within the
 * consumer-logs budget; a failed or slow lookup leaves only the rule-derived fields unset.
 */
export async function resolveDlqScheduleFacts(
  entry: Pick<RegisteredDlqDescriptor, 'staleWhen'>,
  messages: readonly Message[],
  queueDepth?: number
): Promise<Map<string, DlqScheduleFacts>> {
  const facts = new Map<string, DlqScheduleFacts>();
  const superseded = entry.staleWhen === 'superseded-schedule';
  const events = messages.flatMap(message => {
    const event = message.MessageId ? parseScheduledEvent(message.Body) : null;
    if (!event) return [];
    const needsRule = superseded || Boolean(attributeFailure(message)?.requestId);
    return [{ messageId: message.MessageId!, needsRule, ...event }];
  });
  const ruleArns = [...new Set(events.filter(event => event.needsRule).map(event => event.ruleArn))];
  const rules = await settleWithinBudget(ruleArns.map(resolveScheduleRule), CONSUMER_LOGS_BUDGET_MS);
  const ruleByArn = new Map(ruleArns.map((arn, index) => [arn, rules[index] ?? null]));
  // A partial listing cannot show that the next run is absent from the queue.
  const wholeQueue = queueDepth !== undefined && queueDepth >= 0 && messages.length >= queueDepth;
  for (const event of events) {
    const rule = ruleByArn.get(event.ruleArn) ?? null;
    const due = superseded && wholeQueue ? nextRunDueAt(event.time, rule) : undefined;
    const runTimes = events.filter(other => other.ruleArn === event.ruleArn).map(other => Date.parse(other.time));
    const nextRunFailed = due !== undefined && nextRunIn(runTimes, Date.parse(event.time), Date.parse(due));
    const region = event.ruleArn.split(':')[3];
    facts.set(event.messageId, {
      scheduledAt: event.time,
      ...(due && !nextRunFailed ? { nextRunDueAt: due } : {}),
      ...(rule?.targetFunctionName ? { logTarget: { functionName: rule.targetFunctionName, region } } : {}),
    });
  }
  return facts;
}

// A run's time can drift from the exact interval (rate() rules), so the next run is matched within half an interval.
function nextRunIn(runTimes: readonly number[], scheduledMs: number, dueMs: number): boolean {
  const slack = (dueMs - scheduledMs) / 2;
  return runTimes.some(time => time > scheduledMs && time < dueMs + slack);
}

/** One admin listing row for a DLQ message; shared by the per-queue and all-queues routes. */
export function toDlqMessageRow(
  entry: Pick<RegisteredDlqDescriptor, 'label' | 'describe' | 'replay' | 'staleWhen' | 'staleDetailTypes'>,
  message: Message,
  ctx: {
    recorded: DlqFailureRecord | undefined;
    lookupFailed: boolean;
    logs: ConsumerLogs | null;
    replayAttempts: number | undefined;
    schedule?: DlqScheduleFacts;
  }
): DlqMessageRow {
  const { recorded } = ctx;
  const attributes = attributeFailure(message);
  const attributed = recorded ? undefined : attributes;
  const failure: DlqRowFailure | undefined = recorded
    ? { errorMessage: recorded.errorMessage, category: recorded.category, source: 'recorded' }
    : attributed
      ? {
          errorMessage: attributed.errorMessage,
          category: 'unknown',
          source: 'attributes',
          errorCode: attributed.errorCode,
        }
      : undefined;
  const logsLink = messageLogsUrl({
    logs: ctx.logs,
    sentTimestamp: message.Attributes?.SentTimestamp,
    requestId: attributes?.requestId,
    targetArn: attributes?.targetArn,
    scheduledAt: ctx.schedule?.scheduledAt,
    scheduleTarget: ctx.schedule?.logTarget,
  });
  return {
    queueLabel: entry.label,
    messageId: message.MessageId!,
    body: message.Body ?? '',
    entity: describeDlqMessage(entry, message.Body),
    sentTimestamp: message.Attributes?.SentTimestamp,
    approximateReceiveCount: message.Attributes?.ApproximateReceiveCount,
    approximateFirstReceiveTimestamp: message.Attributes?.ApproximateFirstReceiveTimestamp,
    logsUrl: logsLink?.url ?? null,
    ...(logsLink ? { logsScope: logsLink.scope } : {}),
    ...(ctx.lookupFailed ? { failureLookupFailed: true as const } : {}),
    failure,
    recommendation: recommendForDlqMessage({
      failure: recorded,
      logs: ctx.logs,
      replayAttempts: ctx.replayAttempts,
      replaySafety: entry.replay,
      staleWhen: staleWhenForMessage(entry, message.Body),
      scheduledAt: ctx.schedule?.scheduledAt,
      nextRunDueAt: ctx.schedule?.nextRunDueAt,
    }),
  };
}
