import { User } from '@bike4mind/database';

export interface BackfillShowCreditsUsedOptions {
  dryRun: boolean;
  /**
   * Also flip stored `false`. Before per-answer cost became default-on, user creation wrote `false`
   * to every account, so a stored `false` cannot be told apart from a deliberate opt-out; this
   * overrides both.
   */
  includeFalse: boolean;
  log?: (message: string) => void;
}

/**
 * Sets showCreditsUsed to true for users who lack it (and, with includeFalse, users who have it
 * false). Returns how many users were (or, in a dry run, would be) updated. Re-runs are no-ops.
 */
export async function backfillShowCreditsUsed(options: BackfillShowCreditsUsedOptions): Promise<number> {
  const { dryRun, includeFalse, log = console.log } = options;
  const filter = includeFalse ? { showCreditsUsed: { $ne: true } } : { showCreditsUsed: { $exists: false } };

  // The raw collection, not the model: Mongoose would bump updatedAt on every user it touches.
  const updated = dryRun
    ? await User.collection.countDocuments(filter)
    : (await User.collection.updateMany(filter, { $set: { showCreditsUsed: true } })).modifiedCount;

  log(
    `[backfill-show-credits-used] ${dryRun ? 'would update' : 'updated'} ${updated} user(s) ` +
      `(${includeFalse ? 'missing or false' : 'missing only'})`
  );
  return updated;
}
