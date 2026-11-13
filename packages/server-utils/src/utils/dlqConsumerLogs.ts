import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  type EventSourceMappingConfiguration,
} from '@aws-sdk/client-lambda';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@bike4mind/observability';
import { getSourceQueueUrl, type SourceQueueName } from './dlqRegistry';

export interface ConsumerLogs {
  region: string;
  logGroups: string[];
  /** How long a message keeps being retried before it lands in the DLQ, in ms. */
  retryWindowMs: number;
  consumerDeployedAt?: string;
  consumerVersion?: string;
}

const MIN_RETRY_WINDOW_MS = 15 * 60_000;
const MAX_RETRY_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_VISIBILITY_TIMEOUT_S = 30;
const CACHE_TTL_MS = 10 * 60_000;
const NULL_CACHE_TTL_MS = 60_000;
// Only mappings being torn down are skipped; Creating/Enabling/Updating still name a live function.
const INACTIVE_MAPPING_STATES = new Set(['Disabled', 'Deleting']);
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
// The queue list resolves every registered queue at once; Lambda's control-plane API shares a low
// per-account request rate, so lookups run a few at a time instead of all in parallel.
const MAX_CONCURRENT_LOOKUPS = 4;
const THROTTLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'Throttling',
  'RequestThrottled',
]);
// A hung AWS call would otherwise hold its slot for the life of the instance and stall every later lookup.
const LOOKUP_TIMEOUT_MS = 10_000;

type LookupResult = { logs: ConsumerLogs | null; retryable: boolean };

export const DEFAULT_LOGS_QUERY =
  'fields @timestamp, @message, @logStream\n' +
  '| filter @message like /(?i)(error|exception|fail|timed out)/\n' +
  '| sort @timestamp desc\n' +
  '| limit 200';

// Well under the web server's 60s Lambda timeout (infra/web.ts): a slow Lambda control plane drops
// logs links instead of failing the admin request.
export const CONSUMER_LOGS_BUDGET_MS = 15_000;

const cache = new Map<string, { promise: Promise<ConsumerLogs | null>; expiresAt: number }>();
let sqsClient: SQSClient | undefined;
const lambdaClients = new Map<string, LambdaClient>();
let activeLookups = 0;
const waitingLookups: Array<() => void> = [];

export function resetConsumerLogsCacheForTests(): void {
  cache.clear();
}

function withLookupTimeout(sourceQueueUrl: string, lookup: Promise<LookupResult>): Promise<LookupResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LookupResult>(resolve => {
    timer = setTimeout(() => {
      Logger.warn('[dlqConsumerLogs] consumer log group lookup timed out', {
        queue: sourceQueueUrl.slice(sourceQueueUrl.lastIndexOf('/') + 1),
      });
      resolve({ logs: null, retryable: true });
    }, LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

async function withLookupSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeLookups >= MAX_CONCURRENT_LOOKUPS) await new Promise<void>(resolve => waitingLookups.push(resolve));
  else activeLookups++;
  try {
    return await run();
  } finally {
    const next = waitingLookups.shift();
    if (next) next();
    else activeLookups--;
  }
}

/** resolveConsumerLogs for a registry source queue; a queue this stage does not link resolves to null. */
export function resolveConsumerLogsForSourceQueue(sourceQueue: SourceQueueName | null): Promise<ConsumerLogs | null> {
  if (sourceQueue === null) return Promise.resolve(null);
  let url: string;
  try {
    url = getSourceQueueUrl(sourceQueue);
  } catch {
    return Promise.resolve(null);
  }
  return resolveConsumerLogs(url).catch(() => null);
}

/**
 * Resolves the CloudWatch log groups of the Lambda consumers reading a source queue, via its
 * event source mappings. Never throws: any AWS error resolves to null so callers can drop the link.
 */
export function resolveConsumerLogs(sourceQueueUrl: string): Promise<ConsumerLogs | null> {
  const now = Date.now();
  const hit = cache.get(sourceQueueUrl);
  if (hit && hit.expiresAt > now) return hit.promise;

  const entry: { promise: Promise<ConsumerLogs | null>; expiresAt: number } = {
    promise: withLookupSlot(() => withLookupTimeout(sourceQueueUrl, lookupConsumerLogs(sourceQueueUrl))).then(
      ({ logs, retryable }) => {
        if (retryable) {
          if (cache.get(sourceQueueUrl) === entry) cache.delete(sourceQueueUrl);
        } else if (logs === null) {
          entry.expiresAt = Date.now() + NULL_CACHE_TTL_MS;
        }
        return logs;
      }
    ),
    expiresAt: now + CACHE_TTL_MS,
  };
  cache.set(sourceQueueUrl, entry);
  return entry.promise;
}

/** `retryable` marks a throttled or timed-out lookup, which is not cached so the next request tries again. */
async function lookupConsumerLogs(sourceQueueUrl: string): Promise<LookupResult> {
  const none: LookupResult = { logs: null, retryable: false };
  try {
    const { Attributes: attrs = {} } = await (sqsClient ??= new SQSClient({})).send(
      new GetQueueAttributesCommand({
        QueueUrl: sourceQueueUrl,
        AttributeNames: ['QueueArn', 'VisibilityTimeout', 'RedrivePolicy'],
      })
    );
    const queueArn = attrs.QueueArn;
    if (!queueArn) return none;
    const [, partition, , region] = queueArn.split(':');
    if (partition !== 'aws' || !region || !REGION_RE.test(region)) return none;

    let lambda = lambdaClients.get(region);
    if (!lambda) {
      lambda = new LambdaClient({ region });
      lambdaClients.set(region, lambda);
    }
    const functionArns = new Set<string>();
    let hasQualifiedConsumer = false;
    let marker: string | undefined;
    do {
      const page = await lambda.send(new ListEventSourceMappingsCommand({ EventSourceArn: queueArn, Marker: marker }));
      for (const mapping of page.EventSourceMappings ?? []) {
        const arn = activeFunctionArn(mapping);
        if (arn) {
          functionArns.add(arn);
          if (mapping.FunctionArn!.split(':').length > 7) hasQualifiedConsumer = true;
        }
      }
      marker = page.NextMarker;
    } while (marker);

    const logGroups = new Set<string>();
    let consumerDeployedAt: string | undefined;
    let consumerVersion: string | undefined;
    for (const functionArn of functionArns) {
      // Never retain the response's environment variables.
      const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionArn }));
      // Multiple consumers cannot be attributed to a single recorded failure.
      if (
        !hasQualifiedConsumer &&
        functionArns.size === 1 &&
        config.LastUpdateStatus === 'Successful' &&
        config.LastModified &&
        Number.isFinite(Date.parse(config.LastModified))
      ) {
        consumerDeployedAt = new Date(config.LastModified).toISOString();
        consumerVersion = config.Version;
      }
      const functionName = config.FunctionName ?? functionArn.split(':')[6];
      logGroups.add(config.LoggingConfig?.LogGroup ?? `/aws/lambda/${functionName}`);
    }
    if (logGroups.size === 0) return none;

    return {
      logs: {
        region,
        logGroups: [...logGroups].sort(),
        retryWindowMs: retryWindow(attrs.VisibilityTimeout, attrs.RedrivePolicy),
        ...(consumerDeployedAt ? { consumerDeployedAt, consumerVersion } : {}),
      },
      retryable: false,
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : String(error);
    // The queue name only: the full URL carries the account id.
    Logger.warn('[dlqConsumerLogs] consumer log group lookup failed', {
      queue: sourceQueueUrl.slice(sourceQueueUrl.lastIndexOf('/') + 1),
      error: errorName,
    });
    return { logs: null, retryable: THROTTLE_ERROR_NAMES.has(errorName) };
  }
}

function activeFunctionArn(mapping: EventSourceMappingConfiguration): string | null {
  if (!mapping.FunctionArn || INACTIVE_MAPPING_STATES.has(mapping.State ?? '')) return null;
  // A function ARN has seven colon-separated fields; an eighth is a version or alias qualifier.
  return mapping.FunctionArn.split(':').slice(0, 7).join(':');
}

function retryWindow(visibilityTimeout: string | undefined, redrivePolicy: string | undefined): number {
  const visibilityS = Number(visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT_S);
  let maxReceiveCount = 1;
  try {
    const parsed: unknown = redrivePolicy ? JSON.parse(redrivePolicy) : null;
    const count = Number((parsed as { maxReceiveCount?: unknown } | null)?.maxReceiveCount);
    if (Number.isFinite(count) && count > 0) maxReceiveCount = count;
  } catch {
    // malformed RedrivePolicy: keep the single-receive default
  }
  const windowMs = (Number.isFinite(visibilityS) ? visibilityS : DEFAULT_VISIBILITY_TIMEOUT_S) * 1000 * maxReceiveCount;
  return Math.min(MAX_RETRY_WINDOW_MS, Math.max(MIN_RETRY_WINDOW_MS, windowMs));
}

/** Time range (ms epoch) that covers a dead-lettered message's delivery attempts. */
export function messageLogWindow(
  sentMs: number,
  retryWindowMs: number,
  now: number = Date.now()
): { start: number; end: number } | null {
  if (!Number.isFinite(sentMs)) return null;
  const end = Math.min(now, sentMs + retryWindowMs + 5 * 60_000);
  // min() keeps start <= end when a producer clock stamped the send time in the future.
  return { start: Math.min(sentMs, end) - 2 * 60_000, end };
}

/** Settles each lookup still pending after budgetMs to null, so slow lookups never hold up the caller. */
export async function settleWithinBudget<T>(lookups: Promise<T | null>[], budgetMs: number): Promise<(T | null)[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.all(lookups.map(lookup => Promise.race([lookup, deadline])));
  } finally {
    clearTimeout(timer);
  }
}

// The console's Logs Insights hash takes a rison-like value whose strings are URI-encoded with
// '%' swapped for '*', and the whole fragment is then URI-encoded again with '%' swapped for '$'.
function consoleString(value: string): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `'${encoded.replace(/%/g, '*')}`;
}

export function buildLogsInsightsUrl(params: {
  region: string;
  logGroups: string[];
  start: number;
  end: number;
  query?: string;
}): string | null {
  const { region, logGroups, start, end, query = DEFAULT_LOGS_QUERY } = params;
  if (!REGION_RE.test(region) || logGroups.length === 0) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const detail =
    `~(end~${consoleString(new Date(end).toISOString())}` +
    `~start~${consoleString(new Date(start).toISOString())}` +
    `~timeType~'ABSOLUTE~tz~'UTC` +
    `~editorString~${consoleString(query)}` +
    `~source~(${logGroups.map(g => `~${consoleString(g)}`).join('')}))`;

  return (
    `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:logs-insights` +
    `$3FqueryDetail$3D${encodeURIComponent(detail).replace(/%/g, '$')}`
  );
}
