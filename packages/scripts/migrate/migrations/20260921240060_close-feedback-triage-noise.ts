import { type MigrationFile } from './index';
import { closeTriageNoise } from '../feedbackTriageNoise';

/**
 * Close the New feedback rows that are not reports: "coming soon" waitlist signups (that form now
 * writes to the subscriber waitlist) and thumbs-ups with no comment (now stored Closed on create).
 * Both stay in the collection, so they still count in trends.
 *
 * Idempotent: every filter matches only New rows, so a re-run closes nothing it already closed.
 * For the dry-run count, run the read-only preview first (inside `sst shell` for the stage):
 *   pnpm --filter scripts db:preview-feedback-triage-noise
 *
 * `down()` is a no-op: once closed, these rows cannot be told apart from ones an admin closed.
 */
const migration: MigrationFile = {
  id: 20260921240060,
  name: 'close-feedback-triage-noise',

  up: async () => {
    const closed = await closeTriageNoise();
    console.log(
      `Closed ${closed.waitlistSignups} waitlist signup row(s) and ${closed.bareThumbsUps + closed.placeholderThumbsUps} comment-less thumbs-up row(s).`
    );
  },

  down: async () => {},
};

export default migration;
