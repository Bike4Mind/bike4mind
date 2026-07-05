import mongoose from 'mongoose';

const MigrationSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  name: { type: String, required: true },
  migratedAt: { type: Date, default: Date.now },
});

export const Migration = mongoose.models.Migration || mongoose.model('Migration', MigrationSchema, 'migrations');
