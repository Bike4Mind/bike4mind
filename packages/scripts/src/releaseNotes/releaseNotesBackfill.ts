/**
 * Enqueues release-notes generation for every production release in a date range, oldest first,
 * each diffed against the release before it. Re-running is safe: the handler overwrites unedited
 * notes and keeps edited ones.
 *
 * Usage: pnpm release-notes:backfill [--since 2026-01-01] [--until 2026-02-01] [--queue-url <url>] [--dry-run]
 */
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SQSClient } from '@aws-sdk/client-sqs';
import { getCommitRange, getPRSummary, listReleases } from '../utils/githubApi';
import { buildReleaseNotesPayload, enqueueReleaseNotes, selectBackfillPairs } from './buildPayload';

const parseDate = (value: string | undefined, flag: string): Date | undefined => {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${flag} is not a valid date: ${value}`);
  return date;
};

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option('since', { type: 'string', description: 'Only releases created at or after this date' })
    .option('until', { type: 'string', description: 'Only releases created at or before this date' })
    .option('queue-url', { type: 'string', description: 'Queue URL (or RELEASE_NOTES_QUEUE_URL env var)' })
    .option('dry-run', { type: 'boolean', default: false, description: 'List the releases without sending' })
    .strict()
    .parse();

  const pairs = selectBackfillPairs(
    await listReleases(),
    parseDate(argv.since, '--since'),
    parseDate(argv.until, '--until')
  );
  const queueUrl = argv['queue-url'] ?? process.env.RELEASE_NOTES_QUEUE_URL;
  if (!argv['dry-run'] && !queueUrl) throw new Error('--queue-url or RELEASE_NOTES_QUEUE_URL is required');

  const sqs = new SQSClient({});
  for (const { release, previousTag } of pairs) {
    const payload = await buildReleaseNotesPayload(release, previousTag, { getCommitRange, getPRSummary });
    console.log(`${payload.releaseTag}: ${payload.prs.length} PR(s) since ${previousTag ?? '(none)'}`);
    if (!argv['dry-run'] && queueUrl) await enqueueReleaseNotes(sqs, queueUrl, payload);
  }
  console.log(`${argv['dry-run'] ? 'would enqueue' : 'enqueued'} ${pairs.length} release(s)`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
