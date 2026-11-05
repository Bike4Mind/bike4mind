import mongoose from 'mongoose';

// Contract for an entry in the migration runner's registry (core migrations in
// @bike4mind/scripts, and premium-overlay migrations contributed via b4mContributions).
// Lives here (not in @bike4mind/scripts) so overlays can depend on it without depending on
// @bike4mind/scripts, and so there is exactly one definition - see MigrationManager.up/down.

/**
 * What an `up()` that ran out of time (or left items to retry) returns instead of resolving empty:
 * the runner leaves it out of the applied set so the next run calls it again, without failing the
 * run the way a throw would.
 */
export interface MigrationIncomplete {
  incomplete: true;
  reason: string;
}

export interface MigrationFile {
  id: number;
  name: string;
  /** `startedAt` is when the migrator run began, for migrations that budget against its timeout. */
  up: (ctx?: { startedAt: Date }) => Promise<void | MigrationIncomplete>;
  down: () => Promise<void>;
}

export interface IMigration {
  id: number;
  name: string;
  migratedAt: Date;
}

const MigrationSchema = new mongoose.Schema<IMigration>({
  id: { type: Number, required: true },
  name: { type: String, required: true },
  migratedAt: { type: Date, default: Date.now },
});

export const Migration: mongoose.Model<IMigration> =
  mongoose.models.Migration || mongoose.model<IMigration>('Migration', MigrationSchema, 'migrations');
