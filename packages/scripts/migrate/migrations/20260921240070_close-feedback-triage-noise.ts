import { type MigrationFile } from './index';
import { closeTriageNoise } from '../feedbackTriageNoise';

/**
 * Close New "coming soon" waitlist signups; that form now writes to the subscriber waitlist.
 * Rows stay in the collection and still count in trends. Historical thumbs-ups remain untouched,
 * because missing or expired text cannot distinguish empty reports from lost comments.
 *
 * Idempotent: every filter matches only New rows, so a re-run closes nothing it already closed.
 * For the dry-run count, run the read-only preview first (inside `sst shell` for the stage):
 *   pnpm --filter scripts db:preview-feedback-triage-noise
 *
 * `down()` is a no-op: once closed, these rows cannot be told apart from ones an admin closed.
 */
const migration: MigrationFile = {
  id: 20260921240070,
  name: 'close-feedback-triage-noise',

  up: async () => {
    const closed = await closeTriageNoise();
    console.log(`Closed ${closed.waitlistSignups} waitlist signup row(s). Historical thumbs-ups were preserved.`);
  },

  down: async () => {},
};

export default migration;
