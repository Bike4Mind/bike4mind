import mongoose from 'mongoose';

// Contract for an entry in the migration runner's registry (core migrations in
// @bike4mind/scripts, and premium-overlay migrations contributed via b4mContributions).
// Lives here (not in @bike4mind/scripts) so overlays can depend on it without depending on
// @bike4mind/scripts, and so there is exactly one definition - see MigrationManager.up/down.
export interface MigrationFile {
  id: number;
  name: string;
  up: () => Promise<void>;
  down: () => Promise<void>;
}

const MigrationSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  name: { type: String, required: true },
  migratedAt: { type: Date, default: Date.now },
});

export const Migration = mongoose.models.Migration || mongoose.model('Migration', MigrationSchema, 'migrations');
