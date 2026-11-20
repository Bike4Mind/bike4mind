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

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from, `start marker ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `end marker after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
};
const minutes = (source: string, key: string) => {
  const match = source.match(new RegExp(`${key}:\\s*'(\\d+) minutes'`));
  expect(match, `${key} in minutes`).not.toBeNull();
  return Number(match?.[1]);
};

const queue = () =>
  cut(QUEUES, "const generatedMediaPurgeQueue = new sst.aws.Queue('generatedMediaPurgeQueue'", '\n});');
const subscription = () =>
  cut(QUEUES, 'const generatedMediaPurgeQueueSubscription = generatedMediaPurgeQueue.subscribe(', '\n);');

describe('generatedMediaPurgeQueue', () => {
  it('dead-letters after three receives, with visibility above the handler timeout', () => {
    expect(queue()).toMatch(/queue:\s*generatedMediaPurgeQueueDLQ\.arn/);
    expect(queue()).toMatch(/retry:\s*3\b/);
    expect(minutes(queue(), 'visibilityTimeout')).toBeGreaterThan(minutes(subscription(), 'timeout'));
  });

  it('keeps the worker purge budget under the handler timeout', () => {
    const handler = read('apps/workers/src/queueHandlers/generatedMediaPurge.ts');
    const budget = handler.match(/WORKER_PURGE_BUDGET_MS = (\d+) \* 60 \* 1000/);
    expect(budget, 'WORKER_PURGE_BUDGET_MS in minutes').not.toBeNull();
    expect(Number(budget?.[1])).toBeLessThan(minutes(subscription(), 'timeout'));
  });

  it('subscribes the handler with the VPC, bucket, distribution id and its own queue, one record at a time', () => {
    const sub = subscription();
    expect(sub).toMatch(/handler:\s*'apps\/workers\/src\/queueHandlers\/generatedMediaPurge\.dispatch'/);
    expect(sub).toMatch(/vpc:\s*lambdaVpc/);
    expect(sub).toMatch(
      /link:\s*\[\.\.\.allSecrets,\s*generatedImagesBucket,\s*routerDistributionId,\s*generatedMediaPurgeQueue\]/
    );
    expect(sub).toMatch(/\.\.\.SINGLE_RECORD_BATCH,/);
  });

  it('caps concurrent runs at the event source, not with reserved Lambda concurrency', () => {
    const sub = subscription();
    expect(sub).toMatch(
      /transform:\s*\{\s*eventSourceMapping:\s*\{\s*scalingConfig:\s*\{\s*maximumConcurrency:\s*2\s*\}\s*\}\s*\}/
    );
    expect(sub).not.toMatch(/reserved/);
  });

  it('grants CreateInvalidation on the router distribution only', () => {
    expect(subscription()).toMatch(
      /actions:\s*\['cloudfront:CreateInvalidation'\],\s*resources:\s*\[router\.nodes\.cdn\.apply\(cdn => cdn\.nodes\.distribution\.arn\)\]/
    );
  });

  it('exposes the queue to API Lambdas, alarms on its DLQ and registers it for redrive', () => {
    const web = read('infra/web.ts');
    expect(web).toMatch(/generatedMediaPurgeQueue:\s*generatedMediaPurgeQueue\.url/);
    expect(web).toMatch(/'generated-media-purge':\s*generatedMediaPurgeQueueDLQ\.url/);
    expect(read('infra/dlqAlarms.ts')).toMatch(
      /sourceQueue:\s*'generatedMediaPurgeQueue',\s*queue:\s*generatedMediaPurgeQueueDLQ/
    );
    expect(read('infra/logMonitor.ts')).toMatch(/generatedMediaPurgeQueueSubscription\.nodes\.function/);
  });
});
