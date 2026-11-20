import mongoose, { Model, Schema, model } from 'mongoose';
import { ICounter, ICountersDocument } from '@bike4mind/common';

export const IndividualCounterSchema: Schema<ICounter> = new Schema<ICounter>({
  type: { type: String, required: true },
  value: { type: Number, required: true },
  threshold: { type: Number },
  tags: { type: [String] },
  updatedAt: { type: Date },
});

export const CountersSchema: Schema<ICountersDocument> = new Schema<ICountersDocument>(
  {
    counters: [IndividualCounterSchema],
  },
  {
    timestamps: { createdAt: true, updatedAt: 'lastUpdated' },
  }
);

export const Counters: Model<ICountersDocument> =
  mongoose.models.Counters ?? model<ICountersDocument>('Counters', CountersSchema);
export default Counters;
