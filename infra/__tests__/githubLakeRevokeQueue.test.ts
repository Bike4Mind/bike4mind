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
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
};

describe('githubLakeRevokeQueue', () => {
  it('retries past the longest live sync claim before dead-lettering', () => {
    const queue = cut(QUEUES, "const githubLakeRevokeQueue = new sst.aws.Queue('githubLakeRevokeQueue'", '\n});');
    expect(queue).toMatch(/visibilityTimeout:\s*'12 minutes'/);
    expect(queue).toMatch(/queue:\s*githubLakeRevokeQueueDLQ\.arn/);
    expect(queue).toMatch(/retry:\s*6\b/);
  });

  it('keeps the retry window past the longest sync claim and the visibility above the handler timeout', () => {
    const minutes = (source: string, key: string) => {
      const match = source.match(new RegExp(`${key}:\\s*'(\\d+) minutes'`));
      expect(match, `${key} in minutes`).not.toBeNull();
      return Number(match?.[1]);
    };
    const queue = cut(QUEUES, "const githubLakeRevokeQueue = new sst.aws.Queue('githubLakeRevokeQueue'", '\n});');
    const sub = cut(QUEUES, 'const githubLakeRevokeQueueSubscription = githubLakeRevokeQueue.subscribe(', '\n);');
    const retry = Number(queue.match(/retry:\s*(\d+)/)?.[1]);
    const claim = read('packages/database/src/models/infra/integrations/OrgGitHubLakeConnectionModel.ts').match(
      /CHAINED_SYNC_CLAIM_STALE_MS = (\d+) \* 60 \* 1000/
    );
    expect(claim, 'CHAINED_SYNC_CLAIM_STALE_MS in minutes').not.toBeNull();
    expect(retry * minutes(queue, 'visibilityTimeout')).toBeGreaterThan(Number(claim?.[1]));
    expect(minutes(queue, 'visibilityTimeout')).toBeGreaterThan(minutes(sub, 'timeout'));
  });

  it('subscribes the handler with a 10-minute timeout, the VPC and the bucket, one record at a time, without linking its own queue', () => {
    const sub = cut(QUEUES, 'const githubLakeRevokeQueueSubscription = githubLakeRevokeQueue.subscribe(', '\n);');
    expect(sub).toMatch(/handler:\s*'apps\/client\/server\/queueHandlers\/githubLakeRevoke\.dispatch'/);
    expect(sub).toMatch(/timeout:\s*'10 minutes'/);
    expect(sub).toMatch(/vpc:\s*lambdaVpc/);
    expect(sub).toMatch(/link:\s*\[\.\.\.allSecrets,\s*fabFileBucket\]/);
    expect(sub).not.toMatch(/githubLakeRevokeQueue\]/);
    expect(sub).toMatch(/SINGLE_RECORD_BATCH\s*$/);
  });

  it('alarms on its DLQ', () => {
    expect(read('infra/dlqAlarms.ts')).toMatch(
      /sourceQueue:\s*'githubLakeRevokeQueue',\s*queue:\s*githubLakeRevokeQueueDLQ/
    );
  });

  it('is reachable from the web Lambda that enqueues from the App webhook', () => {
    const web = read('infra/web.ts');
    expect(web).toMatch(/'github-lake-revoke':\s*githubLakeRevokeQueueDLQ\.url/);
    expect(web).toMatch(/githubLakeRevokeQueue:\s*githubLakeRevokeQueue\.url/);
    expect(web.match(/^\s+githubLakeRevokeQueue,$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
