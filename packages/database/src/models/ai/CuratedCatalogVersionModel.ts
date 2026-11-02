import { createHash } from 'node:crypto';
import mongoose, { Model, Schema, model } from 'mongoose';

export const CURATED_VERSION_ORIGINS = ['admin', 'import', 'mirror', 'seed'] as const;
export type CuratedVersionOrigin = (typeof CURATED_VERSION_ORIGINS)[number];

/**
 * One published curated Model Hub list. `manifestBytes` and `signatureBytes` are the exact signed texts clients
 * verify; they are served as stored and never re-serialized.
 */
export interface CuratedCatalogVersionRecord {
  channel: string;
  sequence: number;
  /**
   * Place in the channel's publish chain: 1 for the first version, then the live version's position + 1. Latest is the
   * highest position, not the highest sequence, so a recovery list can replace a higher-sequence list a leaked key signed.
   */
  position: number;
  manifestBytes: string;
  signatureBytes: string;
  /** Hex sha256 of the UTF-8 manifest bytes. */
  sha256: string;
  /** Keys whose signatures verified when the version was stored. */
  keyIds: string[];
  origin: CuratedVersionOrigin;
  publishedAt: Date;
  publishedBy: string | null;
  reason: string | null;
}

export type NewCuratedCatalogVersion = Omit<CuratedCatalogVersionRecord, 'sha256' | 'publishedAt'>;

const IMMUTABLE_MESSAGE = 'CuratedCatalogVersion documents are immutable';
const DUPLICATE_KEY_ERROR_CODE = 11000;

const CuratedCatalogVersionSchema = new Schema<CuratedCatalogVersionRecord>(
  {
    channel: { type: String, required: true },
    sequence: { type: Number, required: true, min: 1 },
    position: { type: Number, required: true, min: 1 },
    manifestBytes: { type: String, required: true },
    signatureBytes: { type: String, required: true },
    sha256: { type: String, required: true },
    keyIds: { type: [String], required: true },
    origin: { type: String, enum: CURATED_VERSION_ORIGINS, required: true },
    publishedAt: { type: Date, required: true },
    publishedBy: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { timestamps: false, versionKey: false }
);

const throwImmutable = (): never => {
  throw new Error(IMMUTABLE_MESSAGE);
};

CuratedCatalogVersionSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  throwImmutable
);
// bulkWrite skips query middleware, so it needs its own guard.
CuratedCatalogVersionSchema.pre('bulkWrite', throwImmutable);
CuratedCatalogVersionSchema.pre('save', function () {
  if (!this.isNew) throwImmutable();
});
CuratedCatalogVersionSchema.pre('aggregate', function () {
  if (this.pipeline().some(stage => '$out' in stage || '$merge' in stage)) throwImmutable();
});

// Two imports checked against the same live version compute the same position, so the second one loses here.
CuratedCatalogVersionSchema.index({ channel: 1, position: -1 }, { unique: true });
CuratedCatalogVersionSchema.index({ channel: 1, sequence: -1 }, { unique: true });

export const CuratedCatalogVersion: Model<CuratedCatalogVersionRecord> =
  (mongoose.models.CuratedCatalogVersion as Model<CuratedCatalogVersionRecord> | undefined) ??
  model<CuratedCatalogVersionRecord>('CuratedCatalogVersion', CuratedCatalogVersionSchema);

const PROJECTION = { _id: 0 } as const;

export type CuratedServedField = 'manifestBytes' | 'signatureBytes';
/** `latest` or a sequence, as in the served file name. */
export type CuratedVersionSelector = 'latest' | number;

export class CuratedCatalogVersionRepository {
  constructor(private readonly versionModel: Model<CuratedCatalogVersionRecord>) {}

  /**
   * Builds the unique indexes (a no-op once they exist); call before appending, outside any transaction, so a fresh
   * or dropped collection never takes a duplicate.
   */
  async ready(): Promise<void> {
    await this.versionModel.createIndexes();
  }

  /** The live version of `channel` (highest position), or null before the first publish. */
  async latest(channel: string): Promise<CuratedCatalogVersionRecord | null> {
    return this.versionModel
      .findOne({ channel }, PROJECTION)
      .sort({ position: -1 })
      .lean<CuratedCatalogVersionRecord>()
      .exec();
  }

  async findBySequence(channel: string, sequence: number): Promise<CuratedCatalogVersionRecord | null> {
    return this.versionModel.findOne({ channel, sequence }, PROJECTION).lean<CuratedCatalogVersionRecord>().exec();
  }

  /** Reads only the one stored text a route serves; null when there is no such version. */
  async readServed(
    channel: string,
    selector: CuratedVersionSelector,
    field: CuratedServedField
  ): Promise<string | null> {
    const query =
      selector === 'latest'
        ? this.versionModel.findOne({ channel }, { _id: 0, [field]: 1 }).sort({ position: -1 })
        : this.versionModel.findOne({ channel, sequence: selector }, { _id: 0, [field]: 1 });
    const found = await query.lean<Pick<CuratedCatalogVersionRecord, CuratedServedField>>().exec();
    return found?.[field] ?? null;
  }

  /** Stores a version; null when `channel` already has its sequence or position (a concurrent publish won). */
  async append(version: NewCuratedCatalogVersion): Promise<CuratedCatalogVersionRecord | null> {
    const record: CuratedCatalogVersionRecord = {
      ...version,
      sha256: createHash('sha256').update(version.manifestBytes, 'utf8').digest('hex'),
      publishedAt: new Date(),
    };
    try {
      await this.versionModel.create(record);
      return record;
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE) return null;
      throw error;
    }
  }
}

export const curatedCatalogVersionRepository = new CuratedCatalogVersionRepository(CuratedCatalogVersion);
