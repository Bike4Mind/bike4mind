import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  // Functions, not arrows: the source calls both with `new`.
  CloudWatchClient: vi.fn().mockImplementation(function () {
    return { send };
  }),
  PutMetricDataCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
  StandardUnit: { Count: 'Count' },
}));

import {
  CHAT_RETRY_METRIC,
  CHAT_RETRY_NAMESPACE,
  MAX_RECORDED_RETRIES,
  TurnTimingRecorder,
  classifyTurnRetryReason,
  describeTurnRetry,
} from './turnTiming';

// The exact text the Anthropic backend rejects with on an idle timeout - note "may be overloaded".
const IDLE_TIMEOUT_ERROR = new Error(
  'Anthropic API stream timeout - no response received within 90 seconds. The model may be overloaded. Try simplifying your request or using fewer tools.'
);

const withStatus = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra });

describe('classifyTurnRetryReason', () => {
  it('reads our own idle timeout as a stall, not provider overload', () => {
    expect(classifyTurnRetryReason(IDLE_TIMEOUT_ERROR)).toBe('stream_idle_timeout');
  });

  it.each([
    [new Error('Anthropic API request timeout after 60s'), 'request_timeout'],
    [new Error('unexpected tool_use_id found in tool_result blocks'), 'tool_pairing'],
    [withStatus('Too many requests', 429), 'rate_limit'],
    [withStatus('Overloaded', 529), 'overloaded'],
    [withStatus('Service Unavailable', 503), 'overloaded'],
    [withStatus('Internal server error', 500), 'server_error'],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'transport'],
    [new Error('invalid request: messages must alternate'), 'other'],
  ] as const)('classifies %s as %s', (error, reason) => {
    expect(classifyTurnRetryReason(error)).toBe(reason);
  });
});

describe('describeTurnRetry', () => {
  it('lifts status, request id and Retry-After from a provider SDK error', () => {
    const headers = new Headers({ 'retry-after': '7', 'request-id': 'req_from_header' });
    const error = withStatus('rate limited', 429, { headers, requestID: 'req_abc' });

    expect(describeTurnRetry(error, 2000.4, 'model-a')).toMatchObject({
      reason: 'rate_limit',
      status: 429,
      retryAfterMs: 7000,
      requestId: 'req_abc',
      delayMs: 2000,
      model: 'model-a',
    });
  });

  it('falls back to the request-id header and reads plain-object headers', () => {
    const error = withStatus('overloaded', 529, { headers: { 'request-id': 'req_plain' } });

    expect(describeTurnRetry(error, 0, 'model-a').requestId).toBe('req_plain');
  });

  it('leaves optional fields off when the error carries none', () => {
    const retry = describeTurnRetry(IDLE_TIMEOUT_ERROR, 3500, 'model-a');

    expect(retry).not.toHaveProperty('status');
    expect(retry).not.toHaveProperty('retryAfterMs');
    expect(retry).not.toHaveProperty('requestId');
  });
});

describe('TurnTimingRecorder', () => {
  const createdAt = new Date('2026-10-21T02:20:00.000Z');
  const processStartedAt = createdAt.getTime() + 150;

  beforeEach(() => {
    send.mockReset().mockResolvedValue({});
    delete process.env.SEED_STAGE_NAME;
  });
  afterEach(() => {
    delete process.env.SEED_STAGE_NAME;
  });

  it('measures queue time from quest creation to processing start', () => {
    expect(new TurnTimingRecorder(createdAt, processStartedAt).snapshot()).toEqual({
      queueMs: 150,
      semaphoreWaitMs: 0,
      retries: [],
      fallbackHops: 0,
    });
  });

  it('keeps the first context-build mark, since retries re-enter the loop', () => {
    const recorder = new TurnTimingRecorder(createdAt, processStartedAt);

    recorder.markLlmRequestStarted(processStartedAt + 2400);
    recorder.markLlmRequestStarted(processStartedAt + 99_000);

    expect(recorder.snapshot().contextBuildMs).toBe(2400);
  });

  it('sums semaphore waits across tool rounds through the backend sink', () => {
    const recorder = new TurnTimingRecorder(createdAt, processStartedAt);

    recorder.sink.onSemaphoreWait(0);
    recorder.sink.onSemaphoreWait(120);
    recorder.sink.onSemaphoreWait(30);

    expect(recorder.snapshot().semaphoreWaitMs).toBe(150);
  });

  it('records retries from both the loop and the backend sink, and counts fallback hops', () => {
    const recorder = new TurnTimingRecorder(createdAt, processStartedAt);

    recorder.recordRetry(IDLE_TIMEOUT_ERROR, 3500, 'model-a');
    recorder.sink.onRetry({ error: withStatus('Overloaded', 529), delayMs: 500, model: 'model-a' });
    recorder.recordFallbackHop();

    const timing = recorder.snapshot();
    expect(timing.retries.map(retry => retry.reason)).toEqual(['stream_idle_timeout', 'overloaded']);
    expect(timing.fallbackHops).toBe(1);
  });

  it('caps the persisted retry list', () => {
    const recorder = new TurnTimingRecorder(createdAt, processStartedAt);

    for (let i = 0; i < MAX_RECORDED_RETRIES + 5; i++) recorder.recordRetry(IDLE_TIMEOUT_ERROR, 0, 'model-a');

    expect(recorder.snapshot().retries).toHaveLength(MAX_RECORDED_RETRIES);
  });

  it('sets totalMs from quest creation on finish', () => {
    const recorder = new TurnTimingRecorder(createdAt, processStartedAt);

    recorder.finish(createdAt.getTime() + 415_000);

    expect(recorder.snapshot().totalMs).toBe(415_000);
  });

  it('hands out snapshots a later record cannot mutate', () => {
    const recorder = new TurnTimingRecorder(createdAt, processStartedAt);
    const before = recorder.snapshot();

    recorder.recordRetry(IDLE_TIMEOUT_ERROR, 0, 'model-a');

    expect(before.retries).toHaveLength(0);
  });

  it('emits ChatRetry by Stage, Reason and Model on a deployed stage', () => {
    process.env.SEED_STAGE_NAME = 'production';
    const recorder = new TurnTimingRecorder(createdAt, processStartedAt);

    recorder.recordRetry(IDLE_TIMEOUT_ERROR, 3500, 'model-a');

    expect(send).toHaveBeenCalledTimes(1);
    const { input } = send.mock.calls[0][0] as {
      input: { Namespace: string; MetricData: Array<{ MetricName: string; Dimensions: unknown }> };
    };
    expect(input.Namespace).toBe(CHAT_RETRY_NAMESPACE);
    expect(input.MetricData[0].MetricName).toBe(CHAT_RETRY_METRIC);
    expect(input.MetricData[0].Dimensions).toEqual([
      { Name: 'Stage', Value: 'production' },
      { Name: 'Reason', Value: 'stream_idle_timeout' },
      { Name: 'Model', Value: 'model-a' },
    ]);
  });

  it('emits nothing outside a deployed stage', () => {
    new TurnTimingRecorder(createdAt, processStartedAt).recordRetry(IDLE_TIMEOUT_ERROR, 0, 'model-a');

    expect(send).not.toHaveBeenCalled();
  });

  it('pins the metric names', () => {
    expect(CHAT_RETRY_NAMESPACE).toBe('Lumina5/LLMStreaming');
    expect(CHAT_RETRY_METRIC).toBe('ChatRetry');
  });
});
