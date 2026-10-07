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

// Both markers must be found: a missed end marker would otherwise slice to end of file and let a
// reformatted block pass on text that belongs to its neighbours.
const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from, `start marker ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `end marker after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe('githubLakeRevokeQueue', () => {
  it('retries past the longest live sync claim before dead-lettering', () => {
    const queue = cut(QUEUES, "const githubLakeRevokeQueue = new sst.aws.Queue('githubLakeRevokeQueue'", '\n});');
    expect(queue).toMatch(/visibilityTimeout:\s*'12 minutes'/);
    expect(queue).toMatch(/queue:\s*githubLakeRevokeQueueDLQ\.arn/);
    expect(queue).toMatch(/retry:\s*7\b/);
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
    // The last receive starts after (retry - 1) visibility windows; it must land past a stale claim.
    expect((retry - 1) * minutes(queue, 'visibilityTimeout')).toBeGreaterThan(Number(claim?.[1]));
    expect(minutes(queue, 'visibilityTimeout')).toBeGreaterThan(minutes(sub, 'timeout'));
  });

  it('subscribes the handler with a 10-minute timeout, the VPC, the bucket and its own queue (slice re-enqueue), one record at a time', () => {
    const sub = cut(QUEUES, 'const githubLakeRevokeQueueSubscription = githubLakeRevokeQueue.subscribe(', '\n);');
    expect(sub).toMatch(/handler:\s*'apps\/client\/server\/queueHandlers\/githubLakeRevoke\.dispatch'/);
    expect(sub).toMatch(/timeout:\s*'10 minutes'/);
    expect(sub).toMatch(/vpc:\s*lambdaVpc/);
    expect(sub).toMatch(/link:\s*\[\.\.\.allSecrets,\s*fabFileBucket,\s*githubLakeRevokeQueue\]/);
    expect(sub).toMatch(/SINGLE_RECORD_BATCH\s*$/);
  });

  it('alarms on its DLQ', () => {
    expect(read('infra/dlqAlarms.ts')).toMatch(
      /sourceQueue:\s*'githubLakeRevokeQueue',\s*queue:\s*githubLakeRevokeQueueDLQ/
    );
  });

  it("ships the revoke and ingest handlers' logs to the log monitor", () => {
    const monitor = read('infra/logMonitor.ts');
    for (const subscription of ['githubLakeRevokeQueueSubscription', 'githubLakeIngestQueueSubscription']) {
      expect(monitor).toMatch(new RegExp(`^\\s+${subscription}\\.nodes\\.function\\.nodes\\.logGroup\\.apply\\(`, 'm'));
    }
  });

  it('is reachable from the web Lambda that enqueues from the App webhook', () => {
    const web = read('infra/web.ts');
    expect(web).toMatch(/'github-lake-revoke':\s*githubLakeRevokeQueueDLQ\.url/);
    expect(web).toMatch(/githubLakeRevokeQueue:\s*githubLakeRevokeQueue\.url/);
    // Inside the web Lambda's link array, not just the import list at the top of the file.
    const link = cut(web, '    link: [', '\n    ],');
    expect(link).toMatch(/^\s+githubLakeRevokeQueue,$/m);
  });
});
