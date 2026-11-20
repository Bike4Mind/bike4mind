import mongoose, { Schema } from 'mongoose';

export type MorningBriefLink = { label: string; href: string };
export type AdminMorningBrief = {
  _id: string;
  environment: string;
  day: string;
  generatedAt: Date;
  facts: string;
  summary: string | null;
  needsHuman: MorningBriefLink[];
  delivery: 'ready' | 'sending' | 'sent' | 'unconfirmed' | 'unconfigured';
};

const schema = new Schema<AdminMorningBrief>(
  {
    _id: { type: String, required: true },
    environment: { type: String, required: true },
    day: { type: String, required: true },
    generatedAt: { type: Date, required: true },
    facts: { type: String, required: true },
    summary: { type: String, default: null },
    needsHuman: {
      type: [new Schema({ label: String, href: String }, { _id: false })],
      default: [],
    },
    delivery: {
      type: String,
      enum: ['ready', 'sending', 'sent', 'unconfirmed', 'unconfigured'],
      default: 'ready',
    },
  },
  { versionKey: false, collection: 'AdminMorningBrief' }
);

export const AdminMorningBriefModel =
  (mongoose.models.AdminMorningBrief as mongoose.Model<AdminMorningBrief> | undefined) ??
  mongoose.model<AdminMorningBrief>('AdminMorningBrief', schema);

export const adminMorningBriefRepository = {
  async saveOnce(brief: Omit<AdminMorningBrief, 'delivery'>): Promise<AdminMorningBrief> {
    return AdminMorningBriefModel.findOneAndUpdate(
      { _id: brief._id },
      { $setOnInsert: { ...brief, delivery: 'ready' } },
      { upsert: true, new: true, lean: true }
    ).orFail();
  },
  async claimDelivery(id: string): Promise<AdminMorningBrief | null> {
    return AdminMorningBriefModel.findOneAndUpdate(
      { _id: id, delivery: 'ready' },
      { $set: { delivery: 'sending' } },
      { new: true, lean: true }
    );
  },
  async finishDelivery(id: string, delivery: 'sent' | 'unconfirmed' | 'unconfigured'): Promise<void> {
    await AdminMorningBriefModel.updateOne({ _id: id, delivery: 'sending' }, { $set: { delivery } });
  },
  async setSummary(id: string, summary: string): Promise<void> {
    await AdminMorningBriefModel.updateOne({ _id: id, delivery: 'sending' }, { $set: { summary } });
  },
  async findLatest(environment: string): Promise<AdminMorningBrief | null> {
    // The primary key orders UTC days within an environment, without a second index.
    return AdminMorningBriefModel.findOne({ _id: { $gte: `${environment}:`, $lt: `${environment};` } })
      .sort({ _id: -1 })
      .lean();
  },
};
