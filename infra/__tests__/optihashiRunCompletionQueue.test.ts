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
const QUEUES = readFileSync(path.join(REPO_ROOT, 'infra/queues.ts'), 'utf8');

function subscriptionSource(): string {
  const start = QUEUES.indexOf(
    'const optihashiRunCompletionQueueSubscription = optihashiRunCompletionQueue.subscribe('
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end = QUEUES.indexOf('\n});', start);
  expect(end).toBeGreaterThan(start);
  return QUEUES.slice(start, end);
}

describe('optihashi run completion queue subscription', () => {
  it('can invoke any Bedrock model, streaming or not', () => {
    expect(subscriptionSource()).toMatch(
      /\{\s*actions:\s*\[\s*'bedrock:InvokeModel',\s*'bedrock:InvokeModelWithResponseStream'\s*\],\s*resources:\s*\[\s*'\*'\s*\]\s*\}/
    );
  });

  it('keeps its metric and websocket grants', () => {
    const sub = subscriptionSource();
    expect(sub).toMatch(/actions:\s*\['cloudwatch:PutMetricData'\],\s*resources:\s*\['\*'\]/);
    expect(sub).toMatch(/actions:\s*\['execute-api:ManageConnections'\],\s*resources:\s*\['\*'\]/);
  });
});
