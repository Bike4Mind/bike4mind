import mongoose, { Schema } from 'mongoose';
import type { DisposableListSource, DisposableSourceStatus, DomainIntel } from '@bike4mind/common';

type DisposableDomain = { domain: string; sources: DisposableListSource[]; seen: Record<string, Date> };

const disposableDomainSchema = new Schema<DisposableDomain>({
  domain: { type: String, required: true, unique: true },
  sources: { type: [String], default: [] },
  // Per-source last-seen run time, so a refresh can drop entries a source no longer lists.
  seen: { type: Schema.Types.Mixed, default: {} },
});
disposableDomainSchema.index({ sources: 1 });

const disposableSourceSchema = new Schema<DisposableSourceStatus>({
  source: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  lastSuccessAt: Date,
  lastError: String,
  lastErrorAt: Date,
});

const domainIntelSchema = new Schema<DomainIntel>({
  domain: { type: String, required: true, unique: true },
  registeredAt: Date,
  mxHosts: { type: [String], default: [] },
  mxFlags: { type: [String], default: [] },
  failed: { type: [String], default: [] },
  checkedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
domainIntelSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DisposableDomainModel: mongoose.Model<DisposableDomain> =
  (mongoose.models.DisposableDomain as mongoose.Model<DisposableDomain>) ??
  mongoose.model('DisposableDomain', disposableDomainSchema);
export const DisposableDomainSourceModel: mongoose.Model<DisposableSourceStatus> =
  (mongoose.models.DisposableDomainSource as mongoose.Model<DisposableSourceStatus>) ??
  mongoose.model('DisposableDomainSource', disposableSourceSchema);
export const DomainIntelligenceModel: mongoose.Model<DomainIntel> =
  (mongoose.models.DomainIntelligence as mongoose.Model<DomainIntel>) ??
  mongoose.model('DomainIntelligence', domainIntelSchema);

const BATCH_SIZE = 5000;

export const disposableDomainRepository = {
  async disposableSources(domains: string[]): Promise<DisposableListSource[]> {
    if (domains.length === 0) return [];
    const docs = await DisposableDomainModel.find({ domain: { $in: domains } }, { sources: 1 }).lean();
    return [...new Set(docs.flatMap(doc => doc.sources))];
  },
  async findDomainIntel(domain: string): Promise<DomainIntel | null> {
    // The TTL sweep runs about once a minute, so an expired doc can still be read.
    return DomainIntelligenceModel.findOne({ domain, expiresAt: { $gt: new Date() } }, { _id: 0, __v: 0 }).lean();
  },
  async saveDomainIntel(intel: DomainIntel): Promise<void> {
    await DomainIntelligenceModel.updateOne({ domain: intel.domain }, { $set: intel }, { upsert: true });
  },
  /**
   * Make `domains` the full membership of `source`: tag every listed domain, then untag the ones the
   * source did not list in this run and delete entries no source lists any more.
   */
  async replaceDisposableSource(source: DisposableListSource, domains: Iterable<string>, runAt: Date): Promise<void> {
    const seenKey = `seen.${source}`;
    let batch: mongoose.AnyBulkWriteOperation<DisposableDomain>[] = [];
    const flush = async () => {
      if (batch.length) await DisposableDomainModel.bulkWrite(batch, { ordered: false });
      batch = [];
    };
    for (const domain of domains) {
      batch.push({
        updateOne: {
          filter: { domain },
          update: { $addToSet: { sources: source }, $set: { [seenKey]: runAt } },
          upsert: true,
        },
      });
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    await DisposableDomainModel.updateMany(
      { sources: source, [seenKey]: { $lt: runAt } },
      { $pull: { sources: source }, $unset: { [seenKey]: 1 } }
    );
    await DisposableDomainModel.deleteMany({ sources: { $size: 0 } });
  },
  async getDisposableSourceStatus(): Promise<DisposableSourceStatus[]> {
    return DisposableDomainSourceModel.find({}, { _id: 0, __v: 0 }).sort({ source: 1 }).lean();
  },
  async recordDisposableSource(
    source: DisposableListSource,
    result: { count: number; at: Date } | { error: string; at: Date }
  ): Promise<void> {
    const update =
      'error' in result
        ? { $set: { lastError: result.error, lastErrorAt: result.at }, $setOnInsert: { count: 0 } }
        : { $set: { count: result.count, lastSuccessAt: result.at }, $unset: { lastError: 1, lastErrorAt: 1 } };
    await DisposableDomainSourceModel.updateOne({ source }, update, { upsert: true });
  },
};
