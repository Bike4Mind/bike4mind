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
