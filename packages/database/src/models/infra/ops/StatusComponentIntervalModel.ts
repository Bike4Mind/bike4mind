import mongoose, { Model, Schema, model } from 'mongoose';
import { DISPLAY_STATES, type DisplayState } from '@bike4mind/common/status';

const ModelName = 'StatusComponentInterval';

export const STATUS_INTERVAL_RETENTION_DAYS = 400;

export interface IStatusComponentIntervalDoc {
  componentKey: string;
  /** Raw automatic state: no pins, suppressions or maintenance applied. */
  state: DisplayState;
  from: Date;
  /** Null while the interval is open. */
  to: Date | null;
  lastConfirmedAt: Date;
  expiresAt: Date;
}

interface IStatusComponentIntervalModel extends Model<IStatusComponentIntervalDoc> {}

const StatusComponentIntervalSchema = new Schema<IStatusComponentIntervalDoc>(
  {
    componentKey: { type: String, required: true },
    state: { type: String, enum: DISPLAY_STATES, required: true },
    from: { type: Date, required: true },
    to: { type: Date, default: null },
    lastConfirmedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'statusComponentIntervals' }
);

StatusComponentIntervalSchema.index({ componentKey: 1, from: -1 });
StatusComponentIntervalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StatusComponentInterval: IStatusComponentIntervalModel =
  (mongoose.models[ModelName] as IStatusComponentIntervalModel) ||
  model<IStatusComponentIntervalDoc, IStatusComponentIntervalModel>(ModelName, StatusComponentIntervalSchema);
