// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (request: unknown, response: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handler: undefined as Handler | undefined,
  lambda: vi.fn(),
  events: vi.fn(),
  browse: vi.fn(),
  counts: vi.fn(),
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => ({
    get: (handler: Handler) => {
      h.handler = handler;
      return handler;
    },
  }),
}));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(function () {
    return { send: h.lambda };
  }),
  GetFunctionConfigurationCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
  ListEventSourceMappingsCommand: vi.fn(),
}));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(function () {
    return { send: h.events };
  }),
  DescribeRuleCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { kind: 'describe', input };
  }),
  ListTargetsByRuleCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { kind: 'targets', input };
  }),
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqRegistry: () => Array.from({ length: 30 }, (_, index) => ({ label: String(index), sourceQueue: null })),
  getDlqUrl: (label: string) => label,
  describeDlqMessage: () => null,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  getQueueAttributes: h.counts,
}));
vi.mock('@bike4mind/server-utils/utils/dlqMessages', () => ({
  browseDlqMessages: h.browse,
  findDlqFailures: async () => ({ failures: [], lookupFailed: false }),
  countDlqReplayAttempts: async () => null,
  recommendForDlqMessage: () => ({ action: 'inspect', label: 'Inspect first' }),
  messageLogsUrl: () => null,
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import '../all-messages';
import { resetConsumerLogsCacheForTests, resolveFunctionLogGroup } from '@bike4mind/server-utils/utils/dlqConsumerLogs';
import { resetScheduleRuleCacheForTests, resolveScheduleRule } from '@bike4mind/server-utils/utils/dlqScheduleRule';

const partition = 'aws';
const ruleArn = `arn:${partition}:events:us-east-2:000000000000:rule/nightly`;
const functionArn = `arn:${partition}:lambda:us-east-2:000000000000:function:nightly`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.clearAllMocks();
  h.lambda.mockReset();
  h.events.mockReset();
  h.browse.mockReset();
  h.counts.mockReset().mockResolvedValue({ approximateMessageCount: 1, approximateNotVisibleCount: 0 });
  resetConsumerLogsCacheForTests();
  resetScheduleRuleCacheForTests();
  vi.stubEnv('AWS_REGION', 'us-east-2');
  h.lambda.mockImplementation(() => new Promise(() => {}));
  h.browse.mockImplementation(async (label: string) => [
    {
      MessageId: label,
      Body: '{}',
      MessageAttributes: {
        ERROR_CODE: { StringValue: 'ERROR' },
        TARGET_ARN: { StringValue: `${functionArn}-${label}` },
      },
    },
  ]);
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(120_000);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('returns all 30 raw queues after one optional budget and starts no expired queued SDK work', async () => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as Record<string, unknown>).user = { id: 'admin' };
  let completed = false;
  const pending = h.handler!(req, res).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(completed).toBe(true);
  await pending;
  const body: unknown = res._getJSONData();
  expect(body).toMatchObject({ messages: expect.any(Array), queues: expect.any(Array) });
  expect((body as { messages: unknown[] }).messages).toHaveLength(30);
  expect(h.browse).toHaveBeenCalledTimes(30);
  const started = h.lambda.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.lambda).toHaveBeenCalledTimes(started);
});

it('does not begin a configuration request whose deadline expired while waiting for a global slot', async () => {
  const deadline = Date.now() + 100;
  const lookups = Array.from({ length: 5 }, (_, index) =>
    resolveFunctionLogGroup('us-east-2', `queued-${index}`, deadline)
  );
  let completed = false;
  const pending = Promise.all(lookups).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(completed).toBe(true);
  await pending;
  expect(h.lambda).toHaveBeenCalledTimes(4);
  h.lambda.mockResolvedValue({ FunctionName: 'queued-4' });
  expect(await resolveFunctionLogGroup('us-east-2', 'queued-4', Date.now() + 100)).toBe('/aws/lambda/queued-4');
  expect(h.lambda).toHaveBeenCalledTimes(5);
});

it('rejects a described rule with a different account instead of looking up its local namesake', async () => {
  h.events.mockResolvedValue({ Arn: ruleArn.replace('000000000000', '111111111111'), State: 'ENABLED' });
  expect(await resolveScheduleRule(ruleArn)).toBeNull();
  expect(h.events).toHaveBeenCalledTimes(1);
});

it('does not start target enumeration after the request deadline', async () => {
  let finish: ((value: unknown) => void) | undefined;
  h.events.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  let completed = false;
  const pending = resolveScheduleRule(ruleArn, Date.now() + 100).then(value => {
    completed = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(completed).toBe(true);
  expect(await pending).toBeNull();
  finish!({ Arn: ruleArn, State: 'ENABLED' });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.events).toHaveBeenCalledTimes(1);
});

it("a short cache waiter cannot cancel or evict another request's successful lookup", async () => {
  let finish: ((value: unknown) => void) | undefined;
  h.lambda.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const owner = resolveFunctionLogGroup('us-east-2', 'shared', Date.now() + 1000);
  const waiter = resolveFunctionLogGroup('us-east-2', 'shared', Date.now() + 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await waiter).toBeNull();
  finish!({ FunctionName: 'shared', LoggingConfig: { LogGroup: '/shared' } });
  expect(await owner).toBe('/shared');
  expect(await resolveFunctionLogGroup('us-east-2', 'shared')).toBe('/shared');
  expect(h.lambda).toHaveBeenCalledTimes(1);
});

it('does not grant a fresh optional budget after slow queue counts', async () => {
  h.counts.mockImplementation(
    () =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              approximateMessageCount: 1,
              approximateNotVisibleCount: 0,
            }),
          20_000
        )
      )
  );
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as Record<string, unknown>).user = { id: 'admin' };
  const pending = h.handler!(req, res);
  await vi.advanceTimersByTimeAsync(20_000);
  await pending;
  expect((res._getJSONData() as { messages: unknown[] }).messages).toHaveLength(30);
  expect(h.lambda).not.toHaveBeenCalled();
});

it('deduplicates fast schedule facts and resolves the full account-qualified target', async () => {
  const foreignAccountTarget = functionArn.replace('000000000000', '111111111111');
  h.events.mockImplementation(async (command: { kind: string }) =>
    command.kind === 'describe'
      ? { Arn: ruleArn, State: 'ENABLED', ScheduleExpression: 'rate(1 hour)' }
      : { Targets: [{ Arn: `${foreignAccountTarget}:live` }] }
  );
  h.lambda.mockResolvedValue({ FunctionName: 'nightly', LoggingConfig: { LogGroup: '/nightly' } });
  h.browse.mockImplementation(async (label: string) => [
    {
      MessageId: label,
      Body: JSON.stringify({
        'detail-type': 'Scheduled Event',
        source: 'aws.events',
        time: '2026-01-01T00:00:00Z',
        resources: [ruleArn],
      }),
      MessageAttributes: {
        ErrorCode: { StringValue: '200' },
        RequestID: { StringValue: '00000000-0000-0000-0000-000000000000' },
      },
    },
  ]);
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as Record<string, unknown>).user = { id: 'admin' };
  await h.handler!(req, res);
  expect((res._getJSONData() as { messages: unknown[] }).messages).toHaveLength(30);
  expect(h.events.mock.calls.map(([command]) => command)).toEqual([
    { kind: 'describe', input: { Name: 'nightly' } },
    { kind: 'targets', input: { Rule: 'nightly' } },
  ]);
  expect(h.lambda).toHaveBeenCalledExactlyOnceWith({ input: { FunctionName: foreignAccountTarget } });
});

it('does not resolve named-bus rules against the default bus', async () => {
  expect(await resolveScheduleRule(ruleArn.replace('rule/', 'rule/custom/'))).toBeNull();
  expect(h.events).not.toHaveBeenCalled();
});

it.each([
  { Targets: [{ Arn: functionArn.replace('us-east-2', 'eu-west-1') }] },
  { Targets: [{ Arn: 'malformed' }] },
  { Targets: [{ Arn: functionArn }, { Arn: `${functionArn}-other` }] },
  { Targets: [{ Arn: functionArn }], NextToken: 'another-page' },
])('omits uncertain target identity while retaining verified schedule state (%j)', async targets => {
  h.events.mockImplementation(async (command: { kind: string }) =>
    command.kind === 'describe' ? { Arn: ruleArn, State: 'ENABLED', ScheduleExpression: 'rate(1 hour)' } : targets
  );
  expect(await resolveScheduleRule(ruleArn)).toEqual({ state: 'ENABLED', scheduleExpression: 'rate(1 hour)' });
  expect(h.lambda).not.toHaveBeenCalled();
});

it('does not accept a rule response without its identity', async () => {
  h.events.mockResolvedValue({ State: 'ENABLED' });
  expect(await resolveScheduleRule(ruleArn)).toBeNull();
  expect(h.events).toHaveBeenCalledTimes(1);
});
