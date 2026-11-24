/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const QUEUES = read('infra/queues.ts');

const block = (source: string, start: string, end: string) => {
  const at = source.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  return source.slice(at, source.indexOf(end, at));
};

const minutes = (text: string, key: string) => {
  const match = text.match(new RegExp(`${key}:\\s*'(\\d+) minutes'`));
  expect(match, key).not.toBeNull();
  return Number(match![1]);
};

describe('asynchronous callable function call queue', () => {
  const queue = block(QUEUES, "new sst.aws.Queue('callableFunctionCallQueue'", '\n});');
  const subscription = block(
    QUEUES,
    'const callableFunctionCallQueueSubscription = callableFunctionCallQueue.subscribe(',
    '\n);'
  );

  it('sends failed jobs to its own dead-letter queue', () => {
    expect(QUEUES).toMatch(/new sst\.aws\.Queue\('callableFunctionCallQueueDLQ', \{\}\)/);
    expect(queue).toMatch(/queue:\s*callableFunctionCallQueueDLQ\.arn/);
    expect(queue).toMatch(/retry:\s*\d+/);
  });

  it('runs one record at a time in the queued-call handler', () => {
    expect(subscription).toMatch(/handler:\s*'apps\/workers\/src\/queueHandlers\/callableFunctionCall\.dispatch'/);
    expect(subscription).toMatch(/SINGLE_RECORD_BATCH\s*$/);
  });

  // The handler's longest time limit is derived from this timeout; with retry 2 the one redelivery lands one
  // visibility timeout after receive, which must be after claim + 900 s for any claim within 5 minutes of receive.
  it('gives the consumer 15 minutes and hides a job for 20, so the redelivery lands after a live worker is gone', () => {
    const timeout = minutes(subscription, 'timeout');
    expect(timeout).toBe(15);
    expect(read('packages/server-utils/src/callableFunctions/runtimeLimits.ts')).toMatch(
      /CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS = 900;/
    );
    expect(queue).toMatch(/retry:\s*2\b/);
    expect(minutes(queue, 'visibilityTimeout')).toBe(20);
  });

  it('alarms on its dead-letter queue and shows it in the admin queue list', () => {
    const alarm = block(read('infra/dlqAlarms.ts'), "label: 'callable-function-call'", '}');
    expect(alarm).toMatch(/sourceQueue:\s*'callableFunctionCallQueue'/);
    expect(alarm).toMatch(/queue:\s*callableFunctionCallQueueDLQ/);
    const web = read('infra/web.ts');
    expect(web).toMatch(/'callable-function-call': callableFunctionCallQueueDLQ\.url/);
  });

  it('gives the web function the queue URL the invoke route sends to', () => {
    const web = read('infra/web.ts');
    const linkable = block(web, "new sst.Linkable('sourceQueueUrls'", '\n});');
    expect(linkable).toMatch(/callableFunctionCallQueue: callableFunctionCallQueue\.url/);
    expect(read('apps/client/pages/api/v1/functions/[id]/invoke.ts')).toMatch(
      /getSourceQueueUrl\('callableFunctionCallQueue'\)/
    );
  });
});
