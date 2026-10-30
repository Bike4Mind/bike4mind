// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBusDeadLetter } from '../eventBusDeadLetter';

const readInfra = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const cronSource = readInfra('cron.ts');
// Execute the actual declaration, bounded before the next cron, without loading the full SST app.
const declaration = cronSource.slice(
  cronSource.indexOf('const youngAccountSpendAlert ='),
  cronSource.indexOf('// Signup Grant Held Release')
);

function output<T>(value: T) {
  return { value, apply: <Result>(callback: (input: T) => Result) => callback(value) };
}

function loadCron(source = declaration, runsScheduledJobs = true) {
  const policy = vi.fn(function (_name: string, _args: Record<string, unknown>) {});
  vi.stubGlobal('aws', { sqs: { QueuePolicy: policy } });
  vi.stubGlobal('$util', {
    all: (values: unknown[]) =>
      output(
        values.map(value => (typeof value === 'object' && value !== null && 'value' in value ? value.value : value))
      ),
  });
  const queue = { arn: 'spend-alert-dlq', url: 'spend-alert-dlq-url' };
  const deadLetter = createEventBusDeadLetter(
    'YoungAccountSpendAlert',
    queue as unknown as Parameters<typeof createEventBusDeadLetter>[1]
  );
  const cron = vi.fn(function (_name: string, _args: Record<string, unknown>) {
    return { nodes: { rule: { arn: 'spend-alert-rule' } } };
  });
  runInNewContext(source, {
    runsScheduledJobs,
    youngAccountSpendAlertDeadLetter: deadLetter,
    sst: { aws: { Cron: cron } },
    lambdaVpc: {},
    allSecrets: [],
    DEFAULT_LAMBDA_ENVIRONMENT: {},
    $app: { stage: 'production' },
    process: { env: {} },
    $util: { output },
  });
  const configuration = cron.mock.calls[0]?.[1];
  const transform = configuration?.transform as { target: Record<string, unknown> } | undefined;
  const target: Record<string, unknown> = { input: '{}', ...transform?.target };
  return { cron, policy, target };
}

function verifyDeadLetters(source = declaration) {
  const { cron, policy, target } = loadCron(source);
  expect(cron).toHaveBeenCalledExactlyOnceWith(
    'youngAccountSpendAlert',
    expect.objectContaining({
      schedule: 'rate(1 hour)',
      transform: { target: { deadLetterConfig: { arn: 'spend-alert-dlq' }, input: undefined } },
      function: expect.objectContaining({
        permissions: [{ actions: ['sqs:SendMessage'], resources: ['spend-alert-dlq'] }],
        transform: { function: { deadLetterConfig: { targetArn: 'spend-alert-dlq' } } },
      }),
    })
  );
  expect(target.deadLetterConfig).toEqual({ arn: 'spend-alert-dlq' });
  const args = policy.mock.calls[0]?.[1];
  expect(args?.queueUrl).toBe('spend-alert-dlq-url');
  expect(JSON.parse(String(args?.policy))).toMatchObject({
    Statement: [
      {
        Principal: { Service: 'events.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: 'spend-alert-dlq',
        Condition: { ArnEquals: { 'aws:SourceArn': ['spend-alert-rule'] } },
      },
    ],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('young-account spend alert failure recovery', () => {
  it('dead-letters both delivery and handler failures with a source-scoped policy', () => {
    verifyDeadLetters();
  });

  it('clears SST default input to preserve the ScheduledEvent carrying event.time', () => {
    const verify = (source: string) => {
      const { target } = loadCron(source);
      expect(target.input).toBeUndefined();
    };
    verify(declaration);
    expect(() => verify(declaration.replace('input: undefined,', ''))).toThrow();
  });

  it('creates no cron or policy on stages without scheduled jobs', () => {
    const { cron, policy } = loadCron(declaration, false);
    expect(cron).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
  });

  it.each([
    'permissions: [youngAccountSpendAlertDeadLetter.sendPermission],',
    'transform: youngAccountSpendAlertDeadLetter.functionTarget,',
    '...youngAccountSpendAlertDeadLetter.ruleTarget.target,',
    'youngAccountSpendAlertDeadLetter.allowRules([$util.output(youngAccountSpendAlert)]);',
  ])('rejects a missing recovery link: %s', wiring => {
    expect(declaration).toContain(wiring);
    expect(() => verifyDeadLetters(declaration.replace(wiring, ''))).toThrow();
  });

  it('retains failures for 14 days and registers a standalone DLQ alarm', () => {
    const queueSource = readInfra('youngAccountSpendAlertDeadLetter.ts');
    const source = readInfra('dlqAlarms.ts');
    const block = source.slice(
      source.indexOf('if (youngAccountSpendAlertDeadLetter)'),
      source.indexOf('// FabFile Moderation DLQ')
    );
    const verify = (retention: string, alarm: string) => {
      expect(retention).toContain('messageRetentionSeconds: 1209600');
      expect(alarm).toContain('queue: youngAccountSpendAlertDeadLetter.queue,');
    };
    verify(queueSource, block);
    expect(() => verify(queueSource.replace('messageRetentionSeconds: 1209600', ''), block)).toThrow();
    expect(() => verify(queueSource, block.replace('queue: youngAccountSpendAlertDeadLetter.queue,', ''))).toThrow();
  });
});
