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

describe('githubLakeIngestQueue mirrors the Drive ingest queue', () => {
  it('has a 12-minute visibility timeout and a retry-2 DLQ', () => {
    const queue = cut(QUEUES, "const githubLakeIngestQueue = new sst.aws.Queue('githubLakeIngestQueue'", '\n});');
    expect(queue).toMatch(/visibilityTimeout:\s*'12 minutes'/);
    expect(queue).toMatch(/queue:\s*githubLakeIngestQueueDLQ\.arn/);
    expect(queue).toMatch(/retry:\s*2\b/);
  });

  it('subscribes the handler with a 10-minute timeout, the VPC, the bucket and a self-link, one record at a time', () => {
    const sub = cut(QUEUES, 'const githubLakeIngestQueueSubscription = githubLakeIngestQueue.subscribe(', '\n);');
    expect(sub).toMatch(/handler:\s*'apps\/client\/server\/queueHandlers\/githubLakeIngest\.dispatch'/);
    expect(sub).toMatch(/timeout:\s*'10 minutes'/);
    expect(sub).toMatch(/vpc:\s*lambdaVpc/);
    expect(sub).toMatch(/link:\s*\[\.\.\.allSecrets,\s*fabFileBucket,\s*githubLakeIngestQueue\]/);
    expect(sub).toMatch(/SINGLE_RECORD_BATCH\s*$/);
  });

  it('alarms on its DLQ', () => {
    expect(read('infra/dlqAlarms.ts')).toMatch(
      /sourceQueue:\s*'githubLakeIngestQueue',\s*queue:\s*githubLakeIngestQueueDLQ/
    );
  });

  it('is reachable from the web Lambda that enqueues the connect and re-sync', () => {
    const web = read('infra/web.ts');
    expect(web).toMatch(/'github-lake-ingest':\s*githubLakeIngestQueueDLQ\.url/);
    expect(web).toMatch(/githubLakeIngestQueue:\s*githubLakeIngestQueue\.url/);
    expect(web.match(/^\s+githubLakeIngestQueue,$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
