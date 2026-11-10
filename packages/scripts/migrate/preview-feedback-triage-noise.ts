import { countNewFeedback, mongoose } from '@bike4mind/database';
import { Resource } from 'sst';
import { realpathSync } from 'fs';
import { pathToFileURL } from 'url';
import { countTriageNoise } from './feedbackTriageNoise';

/**
 * READ-ONLY dry run for 20260921240070_close-feedback-triage-noise: how many New feedback rows it
 * would close, over the last 30 days and in total. Its own script rather than a flag on the
 * migration because the migrator records a migration as applied as soon as `up()` resolves.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts db:preview-feedback-triage-noise
 */

const RECENT_DAYS = 30;

export async function main(): Promise<void> {
  const dbUri = Resource.MONGODB_URI.value;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await mongoose.connect(dbUri.replace('%STAGE%', stage), { autoIndex: false, autoCreate: false });

  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const [newTotal, recent, total] = await Promise.all([
    countNewFeedback(),
    countTriageNoise(since),
    countTriageNoise(),
  ]);

  console.log(`Feedback triage noise on stage="${stage}" (read-only). New rows now: ${newTotal}.`);
  console.log(
    `  waitlist signups:      ${recent.waitlistSignups} in the last ${RECENT_DAYS} days, ${total.waitlistSignups} in all`
  );
  console.log(`WOULD CLOSE ${total.waitlistSignups} waitlist row(s). Historical thumbs-ups are preserved.`);
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

// process.exitCode rather than process.exit(), which would truncate piped stdout before the summary.
if (isMainModule)
  void (async () => {
    try {
      await main();
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect().catch((error: unknown) => {
        console.error('Failed to disconnect the feedback preview database', error);
        process.exitCode = 1;
      });
    }
  })();
