#!/usr/bin/env tsx

/**
 * Enqueue owner-only thumbnail renders for every live published bundle whose current version has
 * none yet. Selection and idempotency notes: ./backfillPublishThumbnails.ts.
 *
 * Dry run unless --execute is passed. --limit N caps how many artifacts are selected (oldest
 * first), so a first run can be checked on a handful before the whole library is queued. The
 * worker drains the queue at its own capped concurrency (infra/queues.ts), so a large run only
 * takes longer, it does not fan out.
 *
 * Usage (inside an SST shell so the Mongo URI and the queue URL resolve):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:publish-thumbnails --limit 5
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:publish-thumbnails --execute --limit 5
 * Pass --queue-url to target a queue explicitly instead of the stage's linked one.
 */

import { connectDB } from '@bike4mind/database';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { Resource } from 'sst';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Config } from '../utils/config';
import { backfillPublishThumbnails } from './backfillPublishThumbnails';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('execute', { type: 'boolean', default: false, description: 'Send the jobs (default is a dry run)' })
    .option('limit', { type: 'number', description: 'Select at most this many artifacts' })
    .option('queue-url', { type: 'string', description: 'Thumbnail queue URL (defaults to the stage link)' })
    .strict()
    .parse();
  if (argv.limit !== undefined && (!Number.isInteger(argv.limit) || argv.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  const dryRun = !argv.execute;
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  const queueUrl = dryRun ? '' : (argv['queue-url'] ?? getSourceQueueUrl('publishThumbnailQueue'));
  console.log(`Mode: ${dryRun ? 'DRY RUN (nothing enqueued)' : 'EXECUTE'}${argv.limit ? `, limit ${argv.limit}` : ''}`);
  const result = await backfillPublishThumbnails({
    dryRun,
    limit: argv.limit,
    enqueue: async job => {
      await sendToQueue(queueUrl, job);
    },
  });
  console.log(
    `[backfill-publish-thumbnails] selected ${result.selected}, enqueued ${result.enqueued}, invalid ${result.invalid}`
  );
  if (dryRun) console.log('Dry run only. Re-run with --execute to enqueue.');
  process.exit(0);
}

main().catch(error => {
  console.error('[backfill-publish-thumbnails] failed:', error);
  process.exit(1);
});
