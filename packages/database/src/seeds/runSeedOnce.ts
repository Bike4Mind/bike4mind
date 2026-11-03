import mongoose from 'mongoose';

/**
 * Runs a boot-time seed once per database, for self-host, which has no migration ledger. Without it a
 * row the seed inserts and an admin later removes would be re-inserted on every restart. A seed that
 * throws leaves no marker, so the next boot retries it.
 */
export async function runSeedOnce(name: string, seed: () => Promise<void>): Promise<boolean> {
  const markers = mongoose.connection.collection<{ _id: string; seededAt: Date }>('seedmarkers');
  if (await markers.findOne({ _id: name })) return false;
  await seed();
  await markers.updateOne({ _id: name }, { $setOnInsert: { seededAt: new Date() } }, { upsert: true });
  return true;
}
