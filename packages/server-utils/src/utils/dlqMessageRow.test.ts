import type { Message, MessageAttributeValue } from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./dlqRegistry', () => ({
  getSourceQueueUrl: () => 'https://sqs.example/source',
  describeDlqMessage: () => null,
}));
vi.mock('@bike4mind/database', () => ({
  dlqFailureRepository: { findForMessages: vi.fn() },
  dlqReplayLogRepository: { countAttemptsByMessage: vi.fn() },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: vi.fn() } }));
const resolveScheduleRule = vi.hoisted(() => vi.fn());
vi.mock('./dlqScheduleRule', async importOriginal => ({
  ...(await importOriginal<typeof import('./dlqScheduleRule')>()),
  resolveScheduleRule,
}));
const resolveFunctionLogGroup = vi.hoisted(() => vi.fn());
vi.mock('./dlqConsumerLogs', async importOriginal => ({
  ...(await importOriginal<typeof import('./dlqConsumerLogs')>()),
  resolveFunctionLogGroup,
}));

import { CONSUMER_LOGS_BUDGET_MS } from './dlqConsumerLogs';
import {
  attributeFailure,
  DLQ_SIGNATURE_UNAVAILABLE,
  dlqFailureSignature,
  resolveDlqScheduleFacts,
  resolveDlqTargetLogs,
  toDlqMessageRow,
} from './dlqMessageRow';

const PARTITION = 'aws';

const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const LAMBDA_ARN = `arn:${PARTITION}:lambda:us-east-2:000000000000:function:app-stage-Consumer`;
const RULE_ARN = `arn:${PARTITION}:events:us-east-2:000000000000:rule/app-stage-Nightly`;

const str = (value: string): MessageAttributeValue => ({ DataType: 'String', StringValue: value });
const num = (value: string): MessageAttributeValue => ({ DataType: 'Number', StringValue: value });
const withAttrs = (attributes: Record<string, MessageAttributeValue>): Message => ({
  MessageId: 'm1',
  Body: '{}',
  MessageAttributes: attributes,
});

describe('attributeFailure', () => {
  it('reads the Lambda async invocation shape', () => {
    expect(
      attributeFailure(
        withAttrs({ ErrorCode: num('200'), ErrorMessage: str('Task timed out'), RequestID: str(REQUEST_ID) })
      )
    ).toEqual({
      errorCode: 'Function error',
      errorMessage: 'Task timed out',
      requestId: REQUEST_ID,
      shape: 'lambda-async',
    });
  });

  it('labels a non-200 Lambda invoke status as HTTP', () => {
    expect(attributeFailure(withAttrs({ ErrorCode: num('429'), ErrorMessage: str('Rate exceeded') }))?.errorCode).toBe(
      'HTTP 429'
    );
  });

  it('accepts ARNs in other AWS partitions', () => {
    const govArn = `arn:${PARTITION}-us-gov:lambda:us-gov-west-1:000000000000:function:app-stage-Consumer`;
    expect(
      attributeFailure(withAttrs({ ERROR_CODE: str('SDK_CLIENT_ERROR'), TARGET_ARN: str(govArn) }))?.targetArn
    ).toBe(govArn);
  });

  it('reads the EventBridge target shape with its rule and target', () => {
    expect(
      attributeFailure(
        withAttrs({
          ERROR_CODE: str('SDK_CLIENT_ERROR'),
          ERROR_MESSAGE: str('Rate exceeded'),
          RULE_ARN: str(RULE_ARN),
          TARGET_ARN: str(LAMBDA_ARN),
        })
      )
    ).toEqual({
      errorCode: 'SDK_CLIENT_ERROR',
      errorMessage: 'Rate exceeded',
      ruleArn: RULE_ARN,
      targetArn: LAMBDA_ARN,
      shape: 'eventbridge',
    });
  });

  it('is undefined without attributes, with blank values, or with binary-only values', () => {
    expect(attributeFailure({ MessageId: 'm1' })).toBeUndefined();
    expect(attributeFailure(withAttrs({ ErrorCode: str('  '), ErrorMessage: str('') }))).toBeUndefined();
    expect(
      attributeFailure(withAttrs({ ErrorMessage: { DataType: 'Binary', BinaryValue: new Uint8Array([1, 2]) } }))
    ).toBeUndefined();
    expect(attributeFailure(withAttrs({ RequestID: str(REQUEST_ID) }))).toBeUndefined();
  });

  it('drops a request ID that is not a UUID and ARNs outside lambda/events', () => {
    const failure = attributeFailure(
      withAttrs({
        ERROR_MESSAGE: str('boom'),
        RequestID: str('not-a-uuid"|filter 1'),
        RULE_ARN: str(`arn:${PARTITION}:s3:::bucket`),
        TARGET_ARN: str('https://example.com'),
      })
    );
    expect(failure).toEqual({ errorCode: '', errorMessage: 'boom', shape: 'eventbridge' });
  });

  it('strips control, zero-width and bidi characters and caps length', () => {
    const failure = attributeFailure(
      withAttrs({
        ErrorCode: str(`Bad\u0000Code\u200B${'c'.repeat(200)}`),
        ErrorMessage: str(`line1\nline2 \u202Egnp.exe\u2066 ${'x'.repeat(10_000)}`),
      })
    )!;
    expect(failure.errorMessage.startsWith('line1 line2 gnp.exe ')).toBe(true);
    expect([...failure.errorMessage]).toHaveLength(500);
    expect(failure.errorMessage.endsWith('...')).toBe(true);
    expect(failure.errorCode.startsWith('BadCode')).toBe(true);
    expect([...failure.errorCode]).toHaveLength(100);
    const text = failure.errorMessage + failure.errorCode;
    expect([...text].every(c => c.charCodeAt(0) >= 0x20)).toBe(true);
    expect(text).not.toMatch(/[\u200B\u202E\u2066]/);
  });
});

describe('toDlqMessageRow', () => {
  const entry = { label: 'q1', describe: undefined, replay: 'safe' } as unknown as Parameters<
    typeof toDlqMessageRow
  >[0];
  const ctx = { recorded: undefined, lookupFailed: false, logs: null, replayAttempts: undefined };

  it('marks an attribute-derived failure with its source and the unknown category', () => {
    const row = toDlqMessageRow(entry, withAttrs({ ErrorCode: num('200'), ErrorMessage: str('boom') }), ctx);
    expect(row.failure).toEqual({
      errorMessage: 'boom',
      category: 'unknown',
      source: 'attributes',
      errorCode: 'Function error',
    });
  });

  it('prefers the recorded failure over message attributes', () => {
    const recorded = { messageId: 'm1', errorMessage: 'recorded', category: 'timeout', errorType: 'Error' };
    const row = toDlqMessageRow(entry, withAttrs({ ErrorMessage: str('from attrs') }), {
      ...ctx,
      recorded: recorded as never,
    });
    expect(row.failure).toEqual({ errorMessage: 'recorded', category: 'timeout', source: 'recorded' });
  });

  it('withholds a restricted body unless the caller may see it', () => {
    const restricted = { ...entry, restrictedBody: true } as typeof entry;
    const msg = { MessageId: 'm1', Body: '{"secret":"x"}' };
    expect(toDlqMessageRow(restricted, msg, ctx)).toMatchObject({ body: '', bodyWithheld: true });
    expect(toDlqMessageRow(restricted, msg, { ...ctx, revealRestrictedBody: false }).body).toBe('');
    const revealed = toDlqMessageRow(restricted, msg, { ...ctx, revealRestrictedBody: true });
    expect(revealed.body).toBe('{"secret":"x"}');
    expect(revealed).not.toHaveProperty('bodyWithheld');
    expect(toDlqMessageRow(entry, msg, ctx).body).toBe('{"secret":"x"}');
  });

  it('leaves the failure absent when there is neither', () => {
    expect(toDlqMessageRow(entry, { MessageId: 'm1' }, ctx).failure).toBeUndefined();
  });
});

describe('dlqFailureSignature', () => {
  const attributes = (errorMessage: string, errorCode = 'Function error') =>
    ({ errorMessage, errorCode, category: 'unknown', source: 'attributes' }) as const;

  it('groups failures that differ only in ids, digests and counts', () => {
    const a = dlqFailureSignature(
      attributes('Job 0f8fad5b-d9cb-469f-a165-70867728950e failed after 1200 ms for 64b7f0c2a1d3e4f5a6b7c8d9')
    );
    const b = dlqFailureSignature(
      attributes('Job 7c9e6679-7425-40de-944b-e07fc1f90ae7 failed after 3000 ms for 65c8a1d2b3e4f5a6b7c8d9e0')
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates different messages, codes, sources and categories', () => {
    const base = dlqFailureSignature(attributes('Task timed out'));
    expect(dlqFailureSignature(attributes('Unhandled rejection'))).not.toBe(base);
    expect(dlqFailureSignature(attributes('Task timed out', 'HTTP 429'))).not.toBe(base);
    expect(dlqFailureSignature({ errorMessage: 'Task timed out', category: 'timeout', source: 'recorded' })).not.toBe(
      base
    );
  });

  it('gives a message with no failure its own signature', () => {
    expect(dlqFailureSignature(undefined)).toBe('none');
  });

  it('marks rows whose recorded failure could not be looked up as unavailable', () => {
    const entry = { label: 'q1', describe: undefined, replay: 'safe' } as unknown as Parameters<
      typeof toDlqMessageRow
    >[0];
    const ctx = { recorded: undefined, logs: null, replayAttempts: undefined };
    const message = withAttrs({ ErrorMessage: str('boom') });
    expect(toDlqMessageRow(entry, message, { ...ctx, lookupFailed: true }).failureSignature).toBe(
      DLQ_SIGNATURE_UNAVAILABLE
    );
    expect(toDlqMessageRow(entry, message, { ...ctx, lookupFailed: false }).failureSignature).toBe(
      dlqFailureSignature(attributes('boom', ''))
    );
  });
});

describe('resolveDlqScheduleFacts', () => {
  const scheduled = (id: string, attributes: Record<string, MessageAttributeValue> = {}): Message => ({
    MessageId: id,
    Body: JSON.stringify({
      'detail-type': 'Scheduled Event',
      source: 'aws.events',
      time: '2026-01-02T03:00:00Z',
      resources: [RULE_ARN],
    }),
    MessageAttributes: attributes,
  });

  it('looks up the rule target for a request-id message on an unflagged queue, once per rule', async () => {
    resolveScheduleRule.mockReset().mockResolvedValue({ state: 'ENABLED', targetFunctionArn: LAMBDA_ARN });
    resolveFunctionLogGroup.mockReset().mockResolvedValue('/sst/app/stage/Nightly-LogGroup');
    const facts = await resolveDlqScheduleFacts({ staleWhen: undefined }, [
      scheduled('a', { RequestID: str(REQUEST_ID), ErrorCode: num('200') }),
      scheduled('b', { RequestID: str(REQUEST_ID), ErrorCode: num('200') }),
      scheduled('c'),
    ]);
    expect(resolveScheduleRule).toHaveBeenCalledTimes(1);
    expect(resolveFunctionLogGroup).toHaveBeenCalledTimes(1);
    expect(resolveFunctionLogGroup).toHaveBeenCalledWith('us-east-2', LAMBDA_ARN, expect.any(Number));
    expect(facts.get('a')).toEqual({
      scheduledAt: '2026-01-02T03:00:00.000Z',
      logTarget: { region: 'us-east-2', logGroup: '/sst/app/stage/Nightly-LogGroup' },
    });
    expect(facts.get('a')).not.toHaveProperty('nextRunDueAt');
  });

  it('leaves the log target unset when the function lookup fails', async () => {
    resolveScheduleRule.mockReset().mockResolvedValue({ state: 'ENABLED', targetFunctionArn: LAMBDA_ARN });
    resolveFunctionLogGroup.mockReset().mockResolvedValue(null);
    const facts = await resolveDlqScheduleFacts({ staleWhen: undefined }, [
      scheduled('a', { RequestID: str(REQUEST_ID), ErrorCode: num('200') }),
    ]);
    expect(facts.get('a')).toEqual({ scheduledAt: '2026-01-02T03:00:00.000Z' });
  });

  it('keeps the rule facts when only the function lookup outlasts the budget', async () => {
    vi.useFakeTimers();
    try {
      resolveScheduleRule
        .mockReset()
        .mockResolvedValue({ state: 'ENABLED', scheduleExpression: 'rate(1 hour)', targetFunctionArn: LAMBDA_ARN });
      resolveFunctionLogGroup.mockReset().mockReturnValue(new Promise(() => {}));
      const pending = resolveDlqScheduleFacts(
        { staleWhen: 'superseded-schedule' },
        [scheduled('a', { RequestID: str(REQUEST_ID), ErrorCode: num('200') })],
        1
      );
      await vi.advanceTimersByTimeAsync(CONSUMER_LOGS_BUDGET_MS);
      const facts = await pending;
      expect(facts.get('a')).toEqual({
        scheduledAt: '2026-01-02T03:00:00.000Z',
        nextRunDueAt: '2026-01-02T04:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the lookup when no message needs it', async () => {
    resolveScheduleRule.mockReset();
    const facts = await resolveDlqScheduleFacts({ staleWhen: undefined }, [scheduled('c')]);
    expect(resolveScheduleRule).not.toHaveBeenCalled();
    expect(facts.get('c')).toEqual({ scheduledAt: '2026-01-02T03:00:00.000Z' });
  });
});

describe('toDlqMessageRow stale wiring', () => {
  const ctx = { recorded: undefined, lookupFailed: false, logs: null, replayAttempts: 0 };
  const session = (detailType: string): Message => ({
    MessageId: 'm1',
    Body: JSON.stringify({ 'detail-type': detailType, detail: { sessionId: 's1' } }),
  });
  const selfHealing = {
    label: 'q1',
    replay: 'unsafe',
    staleWhen: 'self-healing',
    staleDetailTypes: ['session.summarize'],
  } as unknown as Parameters<typeof toDlqMessageRow>[0];

  it('applies a scoped self-healing flag only to the listed detail-types', () => {
    expect(toDlqMessageRow(selfHealing, session('session.summarize'), ctx).recommendation.label).toBe(
      'Job obsolete, discard'
    );
    expect(toDlqMessageRow(selfHealing, session('session.tag'), ctx).recommendation.label).not.toBe(
      'Job obsolete, discard'
    );
    expect(toDlqMessageRow(selfHealing, { MessageId: 'm1', Body: 'not json' }, ctx).recommendation.label).not.toBe(
      'Job obsolete, discard'
    );
  });

  it('passes the superseded-schedule flag and schedule facts to the recommendation', () => {
    const schedule = { scheduledAt: '2026-01-01T00:00:00.000Z', nextRunDueAt: '2026-01-01T01:00:00.000Z' };
    const entry = { label: 'q1', replay: 'unsafe', staleWhen: 'superseded-schedule' } as unknown as Parameters<
      typeof toDlqMessageRow
    >[0];
    expect(toDlqMessageRow(entry, { MessageId: 'm1' }, { ...ctx, schedule }).recommendation.label).toBe(
      'Job obsolete, discard'
    );
    expect(
      toDlqMessageRow({ ...entry, staleWhen: undefined }, { MessageId: 'm1' }, { ...ctx, schedule }).recommendation
        .label
    ).not.toBe('Job obsolete, discard');
  });
});

describe('resolveDlqScheduleFacts on a superseded-schedule queue', () => {
  const run = (id: string, time: string): Message => ({
    MessageId: id,
    Body: JSON.stringify({ 'detail-type': 'Scheduled Event', source: 'aws.events', time, resources: [RULE_ARN] }),
  });

  it('sets nextRunDueAt only when the next run is not itself dead-lettered', async () => {
    resolveScheduleRule.mockReset().mockResolvedValue({ state: 'ENABLED', scheduleExpression: 'rate(1 hour)' });
    const facts = await resolveDlqScheduleFacts(
      { staleWhen: 'superseded-schedule' },
      [run('a', '2026-01-02T03:00:00Z'), run('b', '2026-01-02T04:00:20Z')],
      2
    );
    expect(facts.get('a')).not.toHaveProperty('nextRunDueAt');
    expect(facts.get('b')?.nextRunDueAt).toBe('2026-01-02T05:00:20.000Z');
  });

  it('leaves nextRunDueAt unset unless the listing holds the whole queue', async () => {
    resolveScheduleRule.mockReset().mockResolvedValue({ state: 'ENABLED', scheduleExpression: 'rate(1 hour)' });
    const runs = [run('a', '2026-01-02T03:00:00Z')];
    expect((await resolveDlqScheduleFacts({ staleWhen: 'superseded-schedule' }, runs, 1)).get('a')?.nextRunDueAt).toBe(
      '2026-01-02T04:00:00.000Z'
    );
    for (const depth of [undefined, -1, 2]) {
      const facts = await resolveDlqScheduleFacts({ staleWhen: 'superseded-schedule' }, runs, depth);
      expect(facts.get('a'), String(depth)).not.toHaveProperty('nextRunDueAt');
    }
  });

  it('counts only a later run of the same rule as the next run', async () => {
    resolveScheduleRule.mockReset().mockResolvedValue({ state: 'ENABLED', scheduleExpression: 'rate(1 hour)' });
    const other: Message = {
      MessageId: 'other',
      Body: JSON.stringify({
        'detail-type': 'Scheduled Event',
        source: 'aws.events',
        time: '2026-01-02T04:00:00Z',
        resources: [RULE_ARN.replace(/[^/]+$/, 'other-rule')],
      }),
    };
    const facts = await resolveDlqScheduleFacts(
      { staleWhen: 'superseded-schedule' },
      [run('a', '2026-01-02T03:00:00Z'), other],
      2
    );
    expect(facts.get('a')?.nextRunDueAt).toBe('2026-01-02T04:00:00.000Z');
  });

  it('leaves nextRunDueAt unset for a disabled rule', async () => {
    resolveScheduleRule.mockReset().mockResolvedValue({ state: 'DISABLED', scheduleExpression: 'rate(1 hour)' });
    const facts = await resolveDlqScheduleFacts(
      { staleWhen: 'superseded-schedule' },
      [run('a', '2026-01-02T03:00:00Z')],
      1
    );
    expect(facts.get('a')).not.toHaveProperty('nextRunDueAt');
  });
});

describe('resolveDlqTargetLogs', () => {
  const target = (id: string, arn: string): Message => ({
    MessageId: id,
    Body: '{}',
    MessageAttributes: { ERROR_CODE: str('SDK_CLIENT_ERROR'), TARGET_ARN: str(arn) },
  });

  beforeEach(() => {
    vi.stubEnv('AWS_REGION', 'us-east-2');
    resolveFunctionLogGroup.mockReset().mockResolvedValue('/sst/app/stage/Consumer-LogGroup');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resolves each target function once, by its unqualified ARN', async () => {
    const logs = await resolveDlqTargetLogs([target('a', `${LAMBDA_ARN}:live`), target('b', LAMBDA_ARN)]);
    expect(resolveFunctionLogGroup).toHaveBeenCalledTimes(1);
    expect(resolveFunctionLogGroup).toHaveBeenCalledWith('us-east-2', LAMBDA_ARN, expect.any(Number));
    expect(logs.get('a')).toEqual({ region: 'us-east-2', logGroup: '/sst/app/stage/Consumer-LogGroup' });
    expect(logs.get('b')).toEqual({ region: 'us-east-2', logGroup: '/sst/app/stage/Consumer-LogGroup' });
  });

  it('accepts a target in another AWS partition', async () => {
    const govArn = `arn:${PARTITION}-us-gov:lambda:us-east-2:000000000000:function:app-stage-Consumer`;
    const logs = await resolveDlqTargetLogs([target('a', govArn)]);
    expect(resolveFunctionLogGroup).toHaveBeenCalledWith('us-east-2', govArn, expect.any(Number));
    expect(logs.has('a')).toBe(true);
  });

  it('skips targets outside the deploy region, non-function targets, and failed lookups', async () => {
    const otherRegion = `arn:${PARTITION}:lambda:eu-west-1:000000000000:function:other`;
    expect((await resolveDlqTargetLogs([target('a', otherRegion), target('b', RULE_ARN)])).size).toBe(0);
    expect(resolveFunctionLogGroup).not.toHaveBeenCalled();
    resolveFunctionLogGroup.mockResolvedValue(null);
    expect((await resolveDlqTargetLogs([target('c', LAMBDA_ARN)])).size).toBe(0);
  });
});
