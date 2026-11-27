import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(function () {
    return { send: h.send };
  }),
  DescribeRuleCommand: vi.fn().mockImplementation(function (input) {
    return { kind: 'describe', input };
  }),
  ListTargetsByRuleCommand: vi.fn().mockImplementation(function (input) {
    return { kind: 'targets', input };
  }),
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: vi.fn() } }));

import {
  nextRunDueAt,
  parseScheduledEvent,
  resetScheduleRuleCacheForTests,
  resolveScheduleRule,
  scheduledIntervalMs,
} from './dlqScheduleRule';

const PARTITION = 'aws';
const RULE_ARN = `arn:${PARTITION}:events:us-east-2:000000000000:rule/app-stage-Nightly`;
const FUNCTION_ARN = `arn:${PARTITION}:lambda:us-east-2:000000000000:function:app-stage-NightlyFn`;

const respond = (rule: Record<string, unknown>, targets: Array<{ Arn: string }>) =>
  h.send.mockImplementation(async (command: { kind: string }) =>
    command.kind === 'describe' ? { Arn: RULE_ARN, ...rule } : { Targets: targets }
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetScheduleRuleCacheForTests();
  vi.stubEnv('AWS_REGION', 'us-east-2');
});
afterEach(() => vi.unstubAllEnvs());

describe('scheduledIntervalMs', () => {
  it.each([
    ['rate(1 minute)', 60_000],
    ['rate(15 minutes)', 15 * 60_000],
    ['rate(2 hours)', 2 * 3_600_000],
    ['rate(1 day)', 86_400_000],
    ['cron(0 3 * * ? *)', 86_400_000],
    ['cron(30 4 ? * MON *)', 7 * 86_400_000],
  ])('%s is %d ms', (expression, ms) => {
    expect(scheduledIntervalMs(expression)).toBe(ms);
  });

  it.each([
    'cron(0/5 * * * ? *)',
    'cron(0 3 1 * ? *)',
    'cron(0 3 ? * MON-FRI *)',
    'rate(0 minutes)',
    'at(2026-01-01T00:00:00)',
    undefined,
  ])('is undefined for %s', expression => {
    expect(scheduledIntervalMs(expression)).toBeUndefined();
  });
});

describe('parseScheduledEvent', () => {
  const event = {
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    time: '2026-03-01T00:00:00Z',
    resources: [RULE_ARN],
  };

  it('reads the time and rule of a Scheduled Event', () => {
    expect(parseScheduledEvent(JSON.stringify(event))).toEqual({ time: '2026-03-01T00:00:00.000Z', ruleArn: RULE_ARN });
  });

  it.each([
    ['not JSON', 'nope'],
    ['another detail-type', JSON.stringify({ ...event, 'detail-type': 'Object Created' })],
    ['a bad time', JSON.stringify({ ...event, time: 'yesterday' })],
    ['a non-rule ARN', JSON.stringify({ ...event, resources: [FUNCTION_ARN] })],
    ['no resources', JSON.stringify({ ...event, resources: undefined })],
  ])('is null for %s', (_name, body) => {
    expect(parseScheduledEvent(body)).toBeNull();
  });
});

describe('resolveScheduleRule', () => {
  it('returns the rule state, schedule and Lambda target without its qualifier', async () => {
    respond({ State: 'ENABLED', ScheduleExpression: 'rate(1 hour)' }, [{ Arn: `${FUNCTION_ARN}:live` }]);
    expect(await resolveScheduleRule(RULE_ARN)).toEqual({
      state: 'ENABLED',
      scheduleExpression: 'rate(1 hour)',
      targetFunctionArn: FUNCTION_ARN,
    });
    expect(h.send.mock.calls[0][0].input).toEqual({ Name: 'app-stage-Nightly' });
  });

  it('resolves an invalid ARN to null without calling AWS', async () => {
    expect(await resolveScheduleRule(`arn:${PARTITION}:s3:::bucket`)).toBeNull();
    expect(await resolveScheduleRule(RULE_ARN.replace('us-east-2', 'eu-west-1'))).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('caches a result but not a throttled lookup', async () => {
    h.send.mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    expect(await resolveScheduleRule(RULE_ARN)).toBeNull();
    respond({ State: 'DISABLED' }, []);
    expect(await resolveScheduleRule(RULE_ARN)).toEqual({ state: 'DISABLED' });
    await resolveScheduleRule(RULE_ARN);
    expect(h.send).toHaveBeenCalledTimes(3);
  });
});

describe('nextRunDueAt', () => {
  it('adds the interval for an enabled rule only', () => {
    const rule = { state: 'ENABLED' as const, scheduleExpression: 'rate(1 hour)' };
    expect(nextRunDueAt('2026-03-01T00:00:00.000Z', rule)).toBe('2026-03-01T01:00:00.000Z');
    expect(nextRunDueAt('2026-03-01T00:00:00.000Z', { ...rule, state: 'DISABLED' })).toBeUndefined();
    expect(nextRunDueAt('2026-03-01T00:00:00.000Z', null)).toBeUndefined();
  });
});
