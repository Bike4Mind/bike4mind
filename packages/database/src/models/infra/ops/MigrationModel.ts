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
  /**
   * The migration's `up()` may throw on purpose until an operator acts (e.g. an opt-in gate). The
   * runner then leaves it pending, keeps running the remaining migrations, and fails the run at the
   * end. Without it, the first throw stops the run. Later migrations run while it is held, so never
   * flag one that a later migration depends on.
   */
  failClosed?: boolean;
  /**
   * Why `up()` is safe to run again after it failed partway: the runner records a migration only
   * after `up()` returns, so a crash mid-run means the next deploy runs it from the start. Every
   * migration `pnpm migrate generate` creates must fill this in; see packages/scripts/migrate/README.md.
   */
  rerunSafe?: string;
}

export interface IMigration {
  id: number;
  name: string;
  migratedAt: Date;
}

const MigrationSchema = new mongoose.Schema<IMigration>({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  migratedAt: { type: Date, default: Date.now },
});

export const Migration: mongoose.Model<IMigration> =
  mongoose.models.Migration || mongoose.model<IMigration>('Migration', MigrationSchema, 'migrations');

/**
 * The single-runner lease for the migration runner (see packages/scripts/migrate/migrationLock.ts):
 * one document, held by `owner` until `expiresAt`, renewed while the run is alive.
 */
export interface IMigrationLock {
  _id: string;
  owner: string;
  acquiredAt: Date;
  expiresAt: Date;
}

const MigrationLockSchema = new mongoose.Schema<IMigrationLock>(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

export const MigrationLock: mongoose.Model<IMigrationLock> =
  mongoose.models.MigrationLock ||
  mongoose.model<IMigrationLock>('MigrationLock', MigrationLockSchema, 'migrationlocks');
