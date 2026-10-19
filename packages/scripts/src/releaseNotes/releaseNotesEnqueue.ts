/**
 * Enqueues release-notes generation for one production release. Run by the prod release workflow
 * after the GitHub release is created; the queue handler lives in apps/workers (queueHandlers/releaseNotes).
 *
 * Usage: pnpm release-notes:enqueue --tag v1.2.3.4 [--queue-url <url>] [--dry-run]
 */
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SQSClient } from '@aws-sdk/client-sqs';
import { getCommitRange, getPRSummary, listReleases } from '../utils/githubApi';
import { buildReleaseNotesPayload, enqueueReleaseNotes, pairAdjacentReleases } from './buildPayload';

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option('tag', { type: 'string', demandOption: true, description: 'Production release tag (vN.N.N.N)' })
    .option('queue-url', { type: 'string', description: 'Queue URL (or RELEASE_NOTES_QUEUE_URL env var)' })
    .option('dry-run', { type: 'boolean', default: false, description: 'Print the payload instead of sending it' })
    .strict()
    .parse();

  const pair = pairAdjacentReleases(await listReleases()).find(p => p.release.tag_name === argv.tag);
  if (!pair) throw new Error(`no production release found for tag ${argv.tag}`);

  const payload = await buildReleaseNotesPayload(pair.release, pair.previousTag, { getCommitRange, getPRSummary });
  console.log(`${payload.releaseTag}: ${payload.prs.length} PR(s) since ${payload.previousTag ?? '(none)'}`);

  if (argv['dry-run']) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const queueUrl = argv['queue-url'] ?? process.env.RELEASE_NOTES_QUEUE_URL;
  if (!queueUrl) throw new Error('--queue-url or RELEASE_NOTES_QUEUE_URL is required');
  await enqueueReleaseNotes(new SQSClient({}), queueUrl, payload);
  console.log(`enqueued release notes for ${payload.releaseTag}`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
