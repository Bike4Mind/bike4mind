import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetFunctionConfigurationCommand, LambdaClient, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DEFAULT_LOGS_QUERY,
  buildLogsInsightsUrl,
  messageLogWindow,
  resetConsumerLogsCacheForTests,
  resolveConsumerLogs,
  resolveConsumerLogsForSourceQueue,
} from './dlqConsumerLogs';

const registry = vi.hoisted(() => ({ getSourceQueueUrl: vi.fn() }));
vi.mock('./dlqRegistry', () => ({ getSourceQueueUrl: registry.getSourceQueueUrl }));

const sqsMock = mockClient(SQSClient);
const lambdaMock = mockClient(LambdaClient);

const ACCOUNT = '0'.repeat(12);
const QUEUE_URL = ['https://sqs.us-east-2.amazonaws.com', ACCOUNT, 'app-dev-WebhookQueue'].join('/');
const arn = (...fields: string[]) => ['arn', ...fields].join(':');
const QUEUE_ARN = arn('aws', 'sqs', 'us-east-2', ACCOUNT, 'app-dev-WebhookQueue');
const fnArn = (name: string, qualifier?: string) =>
  arn('aws', 'lambda', 'us-east-2', ACCOUNT, 'function', name, ...(qualifier ? [qualifier] : []));

function queueAttrs(attrs: Record<string, string> = {}) {
  sqsMock.on(GetQueueAttributesCommand).resolves({
    Attributes: {
      QueueArn: QUEUE_ARN,
      VisibilityTimeout: '300',
      RedrivePolicy: JSON.stringify({ maxReceiveCount: 5, deadLetterTargetArn: 'x' }),
      ...attrs,
    },
  });
}

function mappings(...arns: string[]) {
  lambdaMock
    .on(ListEventSourceMappingsCommand)
    .resolves({ EventSourceMappings: arns.map(FunctionArn => ({ FunctionArn, State: 'Enabled' })) });
}

describe('resolveConsumerLogs', () => {
  beforeEach(() => {
    sqsMock.reset();
    lambdaMock.reset();
    resetConsumerLogsCacheForTests();
    queueAttrs();
  });

  it('uses the consumer LoggingConfig log group and the region from the queue ARN', async () => {
    mappings(fnArn('app-dev-webhook'));
    lambdaMock
      .on(GetFunctionConfigurationCommand)
      .resolves({ FunctionName: 'app-dev-webhook', LoggingConfig: { LogGroup: '/sst/app/dev/webhook' } });
    const result = await resolveConsumerLogs(QUEUE_URL);
    expect(result).toEqual({ region: 'us-east-2', logGroups: ['/sst/app/dev/webhook'], retryWindowMs: 1_500_000 });
    expect(lambdaMock.commandCalls(ListEventSourceMappingsCommand)[0].args[0].input.EventSourceArn).toBe(QUEUE_ARN);
  });

  it('falls back to /aws/lambda/<name> without a LoggingConfig', async () => {
    mappings(fnArn('app-dev-webhook'));
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'app-dev-webhook' });
    expect((await resolveConsumerLogs(QUEUE_URL))?.logGroups).toEqual(['/aws/lambda/app-dev-webhook']);
  });

  it('returns null when no mapping consumes the queue', async () => {
    mappings();
    expect(await resolveConsumerLogs(QUEUE_URL)).toBeNull();
    expect(lambdaMock.commandCalls(GetFunctionConfigurationCommand)).toHaveLength(0);
  });

  it('skips disabled mappings', async () => {
    lambdaMock
      .on(ListEventSourceMappingsCommand)
      .resolves({ EventSourceMappings: [{ FunctionArn: fnArn('a'), State: 'Disabled' }] });
    expect(await resolveConsumerLogs(QUEUE_URL)).toBeNull();
  });

  it('returns one sorted group per consumer, stripping version qualifiers and deduping', async () => {
    mappings(fnArn('zeta', '3'), fnArn('alpha'), fnArn('zeta', 'live'));
    lambdaMock.on(GetFunctionConfigurationCommand).callsFake(({ FunctionName }) => ({
      FunctionName: String(FunctionName).split(':')[6],
    }));
    const result = await resolveConsumerLogs(QUEUE_URL);
    expect(result?.logGroups).toEqual(['/aws/lambda/alpha', '/aws/lambda/zeta']);
    const asked = lambdaMock.commandCalls(GetFunctionConfigurationCommand).map(c => c.args[0].input.FunctionName);
    expect(asked).toEqual([fnArn('zeta'), fnArn('alpha')]);
  });

  it('follows the Marker across pages', async () => {
    lambdaMock
      .on(ListEventSourceMappingsCommand, { Marker: undefined })
      .resolves({ EventSourceMappings: [{ FunctionArn: fnArn('a'), State: 'Enabled' }], NextMarker: 'm1' })
      .on(ListEventSourceMappingsCommand, { Marker: 'm1' })
      .resolves({ EventSourceMappings: [{ FunctionArn: fnArn('b'), State: 'Enabled' }] });
    lambdaMock.on(GetFunctionConfigurationCommand).callsFake(({ FunctionName }) => ({
      FunctionName: String(FunctionName).split(':')[6],
    }));
    expect((await resolveConsumerLogs(QUEUE_URL))?.logGroups).toEqual(['/aws/lambda/a', '/aws/lambda/b']);
    expect(lambdaMock.commandCalls(ListEventSourceMappingsCommand)).toHaveLength(2);
  });

  it('resolves null without throwing on AccessDenied', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    lambdaMock.on(ListEventSourceMappingsCommand).rejects(denied);
    await expect(resolveConsumerLogs(QUEUE_URL)).resolves.toBeNull();
  });

  it('serves a repeat lookup from cache', async () => {
    mappings(fnArn('a'));
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'a' });
    const [first, second] = await Promise.all([resolveConsumerLogs(QUEUE_URL), resolveConsumerLogs(QUEUE_URL)]);
    await resolveConsumerLogs(QUEUE_URL);
    expect(second).toBe(first);
    expect(sqsMock.commandCalls(GetQueueAttributesCommand)).toHaveLength(1);
    expect(lambdaMock.commandCalls(ListEventSourceMappingsCommand)).toHaveLength(1);
  });

  it('caches a denied lookup as null but retries a throttled one', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    lambdaMock.on(ListEventSourceMappingsCommand).rejects(denied);
    await resolveConsumerLogs(QUEUE_URL);
    await resolveConsumerLogs(QUEUE_URL);
    expect(sqsMock.commandCalls(GetQueueAttributesCommand)).toHaveLength(1);

    resetConsumerLogsCacheForTests();
    sqsMock.resetHistory();
    const throttled = Object.assign(new Error('rate exceeded'), { name: 'TooManyRequestsException' });
    lambdaMock.on(ListEventSourceMappingsCommand).rejects(throttled);
    expect(await resolveConsumerLogs(QUEUE_URL)).toBeNull();
    await resolveConsumerLogs(QUEUE_URL);
    expect(sqsMock.commandCalls(GetQueueAttributesCommand)).toHaveLength(2);
  });

  it('runs at most four lookups at once', async () => {
    let inFlight = 0;
    let peak = 0;
    sqsMock.on(GetQueueAttributesCommand).callsFake(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return { Attributes: { QueueArn: QUEUE_ARN } };
    });
    mappings(fnArn('a'));
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'a' });

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => resolveConsumerLogs(`${QUEUE_URL}${i}`)));

    expect(peak).toBe(4);
    expect(results.every(r => r?.logGroups[0] === '/aws/lambda/a')).toBe(true);
  });

  it('frees a hung lookup slot after the timeout and does not cache it', async () => {
    vi.useFakeTimers();
    try {
      sqsMock.on(GetQueueAttributesCommand).callsFake(() => new Promise(() => {}));
      const hung = Array.from({ length: 4 }, (_, i) => resolveConsumerLogs(`${QUEUE_URL}${i}`));
      const queued = resolveConsumerLogs(`${QUEUE_URL}x`);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await Promise.all(hung)).toEqual([null, null, null, null]);

      sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: QUEUE_ARN } });
      mappings(fnArn('a'));
      lambdaMock.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'a' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await queued).toBeNull();
      expect((await resolveConsumerLogs(`${QUEUE_URL}0`))?.logGroups).toEqual(['/aws/lambda/a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a registry source queue, and null when this stage does not link it', async () => {
    mappings(fnArn('a'));
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'a' });
    registry.getSourceQueueUrl.mockReturnValueOnce(QUEUE_URL).mockImplementationOnce(() => {
      throw new Error('Missing source queue URL');
    });

    expect((await resolveConsumerLogsForSourceQueue('webhookDeliveryQueue'))?.logGroups).toEqual(['/aws/lambda/a']);
    expect(await resolveConsumerLogsForSourceQueue('webhookDeliveryQueue')).toBeNull();
  });

  it('returns null for a non-aws partition', async () => {
    queueAttrs({ QueueArn: arn('aws-cn', 'sqs', 'cn-north-1', ACCOUNT, 'q') });
    expect(await resolveConsumerLogs(QUEUE_URL)).toBeNull();
    expect(lambdaMock.calls()).toHaveLength(0);
  });

  it.each([
    [
      'clamps a short window up to 15 minutes',
      { VisibilityTimeout: '30', RedrivePolicy: '{"maxReceiveCount":3}' },
      15 * 60_000,
    ],
    [
      'clamps a long window down to 24 hours',
      { VisibilityTimeout: '43200', RedrivePolicy: '{"maxReceiveCount":10}' },
      24 * 3_600_000,
    ],
    ['treats a missing RedrivePolicy as one receive', { VisibilityTimeout: '1800', RedrivePolicy: '' }, 1_800_000],
  ])('%s', async (_name, attrs, expected) => {
    queueAttrs(attrs);
    mappings(fnArn('a'));
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({ FunctionName: 'a' });
    expect((await resolveConsumerLogs(QUEUE_URL))?.retryWindowMs).toBe(expected);
  });
});

function decodeDetail(url: string): string {
  const fragment = url.split('#logsV2:logs-insights')[1];
  expect(fragment.startsWith('$3FqueryDetail$3D')).toBe(true);
  return decodeURIComponent(fragment.slice('$3FqueryDetail$3D'.length).replace(/\$/g, '%'));
}

const consoleDecode = (s: string) => decodeURIComponent(s.replace(/\*/g, '%'));

describe('buildLogsInsightsUrl', () => {
  const start = Date.parse('2026-01-02T03:00:00.000Z');
  const end = Date.parse('2026-01-02T04:30:00.000Z');

  it('matches the console golden URL', () => {
    const url = buildLogsInsightsUrl({
      region: 'us-east-2',
      logGroups: ['/aws/lambda/fn'],
      start,
      end,
      query: 'limit 5',
    });
    expect(url).toBe(
      'https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#logsV2:logs-insights' +
        "$3FqueryDetail$3D~(end~'2026-01-02T04*3A30*3A00.000Z~start~'2026-01-02T03*3A00*3A00.000Z" +
        "~timeType~'ABSOLUTE~tz~'UTC~editorString~'limit*205~source~(~'*2Faws*2Flambda*2Ffn))"
    );
  });

  it('round-trips the default query, window and groups with /, $ and _', () => {
    const url = buildLogsInsightsUrl({ region: 'eu-west-1', logGroups: ['/sst/a$b_c', '/aws/lambda/x'], start, end });
    expect(url).not.toBeNull();
    const detail = decodeDetail(url!);
    const strings = [...detail.matchAll(/'([^~)]*)/g)].map(m => consoleDecode(m[1]));
    expect(strings).toEqual([
      '2026-01-02T04:30:00.000Z',
      '2026-01-02T03:00:00.000Z',
      'ABSOLUTE',
      'UTC',
      DEFAULT_LOGS_QUERY,
      '/sst/a$b_c',
      '/aws/lambda/x',
    ]);
    expect(url!.startsWith('https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#')).toBe(true);
  });

  it('returns null for no groups or a bad region', () => {
    expect(buildLogsInsightsUrl({ region: 'us-east-2', logGroups: [], start, end })).toBeNull();
    expect(buildLogsInsightsUrl({ region: 'evil.com/x', logGroups: ['g'], start, end })).toBeNull();
    expect(buildLogsInsightsUrl({ region: 'us-east-2', logGroups: ['g'], start: NaN, end })).toBeNull();
  });
});

describe('messageLogWindow', () => {
  it('spans two minutes before send through the retry window plus five minutes', () => {
    expect(messageLogWindow(1_000_000_000, 900_000, 10_000_000_000)).toEqual({
      start: 1_000_000_000 - 120_000,
      end: 1_000_000_000 + 900_000 + 300_000,
    });
  });

  it('clamps the end to now', () => {
    expect(messageLogWindow(1_000_000_000, 900_000, 1_000_100_000)?.end).toBe(1_000_100_000);
  });

  it('returns null for a NaN send time', () => {
    expect(messageLogWindow(Number.parseInt('', 10), 900_000)).toBeNull();
  });
});
