import mongoose, { Schema, model, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * GearOverride — admin-managed, per-gear overrides layered over the
 * code-defined gear defaults (same defaults+overrides pattern as System
 * Prompts). Every field is optional: an absent field means "use the code
 * default", so an override row is a sparse patch, not a copy.
 *
 * The ops story this exists for: a reward loophole is discovered in prod —
 * an admin flips `enabled` off or drops `credits` to 0 from the Manage Gears
 * dashboard, instantly, with no deploy. `credits` overrides are ABSOLUTE
 * (deliberately not multiplied by GEAR_CREDITS_SCALE) so what the admin
 * types is exactly what pays out.
 */
export interface IGearOverrideDocument extends Document {
  id: string;
  /** GearKey this override applies to (unknown keys are ignored by the merge). */
  key: string;
  enabled?: boolean | null;
  credits?: number | null;
  title?: string | null;
  tagline?: string | null;
  intro?: string | null;
  cta?: string | null;
  /** Presentation action: 'navigate:<path>' | 'external:<url>' | 'files'. */
  ctaAction?: string | null;
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const GearOverrideSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 64 },
    enabled: { type: Boolean, default: null },
    credits: { type: Number, default: null, min: 0, max: 1_000_000 },
    title: { type: String, default: null, maxlength: 80 },
    tagline: { type: String, default: null, maxlength: 120 },
    intro: { type: String, default: null, maxlength: 500 },
    cta: { type: String, default: null, maxlength: 80 },
    ctaAction: { type: String, default: null, maxlength: 300 },
    updatedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'gear_overrides',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

GearOverrideSchema.index({ key: 1 }, { unique: true });

export const GearOverride =
  (mongoose.models.GearOverride as mongoose.Model<IGearOverrideDocument>) ||
  model<IGearOverrideDocument>('GearOverride', GearOverrideSchema);

export class GearOverrideRepository extends BaseRepository<IGearOverrideDocument> {
  constructor(m: Model<IGearOverrideDocument>) {
    super(m);
  }

  async byKey(): Promise<Map<string, IGearOverrideDocument>> {
    const rows = await this.model.find({}).lean<IGearOverrideDocument[]>();
    return new Map(rows.map(r => [r.key, r]));
  }
}

export const gearOverrideRepository = new GearOverrideRepository(GearOverride);
