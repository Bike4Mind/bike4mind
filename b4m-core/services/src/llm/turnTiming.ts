import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { ITurnRetry, ITurnTiming, TurnRetryReason } from '@bike4mind/common';
import { MAX_RECORDED_TURN_RETRIES } from '@bike4mind/common';
import type { TurnTelemetrySink } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { getHttpStatus, isOverloadedError, isRetryableError } from '@bike4mind/utils';
import {
  isRequestTimeoutError,
  isStreamIdleTimeoutError,
  isToolPairingError,
  isTruncatedStreamError,
} from './llmErrorPredicates';

/** Same namespace as the backends' StreamIdleTimeoutTriggered, so the two read side by side. */
export const CHAT_RETRY_NAMESPACE = 'Lumina5/LLMStreaming';
export const CHAT_RETRY_METRIC = 'ChatRetry';

/**
 * Bounds the persisted list on a pathological turn (many tool rounds, each retrying). Retries
 * past the cap still log and emit the metric; only the quest record stops growing. Shared with
 * the client so it can render a full list as a lower bound.
 */
export const MAX_RECORDED_RETRIES = MAX_RECORDED_TURN_RETRIES;

/**
 * Timeouts first: our own idle and request timeouts are a slow model, not provider overload, and
 * older backends worded them "the model may be overloaded", which isOverloadedError matches.
 * Recording that as overload is the misreading this telemetry exists to expose. Must stay in sync with TURN_RETRY_REASONS in @bike4mind/common.
 */
export function classifyTurnRetryReason(error: Error): TurnRetryReason {
  // The truncation error shares the idle timeout's "stream timeout" prefix but is not a stall.
  if (isTruncatedStreamError(error)) return 'stream_truncated';
  if (isStreamIdleTimeoutError(error)) return 'stream_idle_timeout';
  if (isRequestTimeoutError(error)) return 'request_timeout';
  if (isToolPairingError(error)) return 'tool_pairing';

  const status = getHttpStatus(error);
  if (status === 429 || /rate limit|too many requests/i.test(error.message)) return 'rate_limit';
  if (isOverloadedError(error)) return 'overloaded';
  if (status !== undefined && status >= 500) return 'server_error';
  if (isRetryableError(error)) return 'transport';
  return 'other';
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const value =
    'get' in headers && typeof headers.get === 'function'
      ? (headers.get(name) as unknown)
      : (headers as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Provider SDK errors (Anthropic, OpenAI) carry `headers` and `requestID` directly; Axios
// errors nest headers under `response`.
function errorHeaders(error: Error): unknown {
  const shaped = error as { headers?: unknown; response?: { headers?: unknown } };
  return shaped.headers ?? shaped.response?.headers;
}

function readRequestId(error: Error): string | undefined {
  const { requestID } = error as { requestID?: unknown };
  if (typeof requestID === 'string' && requestID.length > 0) return requestID;
  const headers = errorHeaders(error);
  return readHeader(headers, 'request-id') ?? readHeader(headers, 'x-request-id');
}

function readRetryAfterMs(error: Error): number | undefined {
  const headers = errorHeaders(error);
  const rawMs = readHeader(headers, 'retry-after-ms');
  const raw = readHeader(headers, 'retry-after');
  let ms: number;
  if (rawMs) {
    ms = Number(rawMs);
  } else if (raw) {
    const seconds = Number(raw);
    ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  } else {
    return undefined;
  }
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
}

/** Builds the retry record for one failed attempt. Pure, apart from reading the clock. */
export function describeTurnRetry(error: Error, delayMs: number, model: string): ITurnRetry {
  const status = getHttpStatus(error);
  const retryAfterMs = readRetryAfterMs(error);
  const requestId = readRequestId(error);
  return {
    reason: classifyTurnRetryReason(error),
    ...(status !== undefined && { status }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    ...(requestId !== undefined && { requestId }),
    delayMs: Math.round(delayMs),
    model,
    at: new Date(),
  };
}

/**
 * Fire-and-forget `ChatRetry` datapoint, by Reason and Model. No-ops outside deployed stages
 * (`SEED_STAGE_NAME` comes from DEFAULT_LAMBDA_ENVIRONMENT in infra/constants.ts).
 */
export function emitChatRetryMetric(retry: ITurnRetry, logger?: Logger): void {
  const stage = process.env.SEED_STAGE_NAME;
  if (!stage) return;

  // Fresh client per call: warm Lambda containers outlive their credentials.
  const client = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
  client
    .send(
      new PutMetricDataCommand({
        Namespace: CHAT_RETRY_NAMESPACE,
        MetricData: [
          {
            MetricName: CHAT_RETRY_METRIC,
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: retry.at,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Reason', Value: retry.reason },
              { Name: 'Model', Value: retry.model },
            ],
          },
        ],
      })
    )
    .catch((error: unknown) => {
      logger?.warn(`Failed to emit ${CHAT_RETRY_METRIC} metric`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Accumulates one chat turn's {@link ITurnTiming}. ChatCompletionProcess owns it, records the
 * retries its own loop schedules, and hands `sink` to the backend so per-round semaphore waits and
 * transport retries land here too.
 */
export class TurnTimingRecorder {
  private readonly timing: ITurnTiming;
  private retryCount = 0;
  private storedRetry?: (retry: ITurnRetry) => ITurnRetry;

  constructor(
    private readonly turnStartedAt: Date,
    private readonly processStartedAt: number,
    private readonly logger?: Logger,
    /** Called after every change, so the quest carries what a backend reported mid-turn. */
    private readonly onChange?: (timing: ITurnTiming) => void
  ) {
    this.timing = {
      queueMs: Math.max(0, processStartedAt - turnStartedAt.getTime()),
      semaphoreWaitMs: 0,
      retries: [],
      fallbackHops: 0,
    };
  }

  readonly sink: TurnTelemetrySink = {
    onSemaphoreWait: waitMs => this.addSemaphoreWait(waitMs),
    onRetry: ({ error, delayMs, model }) => {
      this.recordRetry(error, delayMs, model);
    },
  };

  /** Ends the context-build span. Only the first call counts: retries and hops re-enter the loop. */
  markLlmRequestStarted(now = Date.now()): void {
    if (this.timing.contextBuildMs !== undefined) return;
    this.timing.contextBuildMs = Math.max(0, now - this.processStartedAt);
    this.changed();
  }

  addSemaphoreWait(waitMs: number): void {
    if (waitMs <= 0) return;
    this.timing.semaphoreWaitMs += Math.round(waitMs);
    this.changed();
  }

  recordRetry(error: Error, delayMs: number, model: string): ITurnRetry {
    const retry = describeTurnRetry(error, delayMs, model);
    this.retryCount += 1;
    if (this.timing.retries.length < MAX_RECORDED_RETRIES) {
      this.timing.retries.push(this.storedRetry ? this.storedRetry(retry) : retry);
    }
    this.logger?.info(`[ChatRetry] ${retry.reason} on ${model}, retrying in ${retry.delayMs}ms`, {
      ...retry,
      attempt: this.retryCount,
    });
    emitChatRetryMetric(retry, this.logger);
    this.changed();
    return retry;
  }

  /** Rewrites each retry before it reaches the quest; the server log and metric keep the original. */
  maskStoredRetries(mask: (retry: ITurnRetry) => ITurnRetry): void {
    this.storedRetry = mask;
  }

  recordFallbackHop(): void {
    this.timing.fallbackHops += 1;
    this.changed();
  }

  finish(now = Date.now()): void {
    this.timing.totalMs = Math.max(0, now - this.turnStartedAt.getTime());
    this.changed();
  }

  private changed(): void {
    this.onChange?.(this.snapshot());
  }

  /** A copy, so a later record does not mutate what was already handed to the quest. */
  snapshot(): ITurnTiming {
    return { ...this.timing, retries: this.timing.retries.map(retry => ({ ...retry })) };
  }
}
