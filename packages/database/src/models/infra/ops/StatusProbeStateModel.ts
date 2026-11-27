import mongoose, { Model, Schema, model } from 'mongoose';
import { DISPLAY_STATES, type DisplayState } from '@bike4mind/common/status';

const ModelName = 'StatusProbeState';

export interface IStatusProbeStateDoc {
  probeKey: string;
  componentKey: string;
  state: DisplayState;
  fails: number;
  degradeds: number;
  passes: number;
  lastResultAt: Date;
  lastRunScheduledAt: Date;
  lastChangeAt: Date;
  lastErrorClass?: string;
}

interface IStatusProbeStateModel extends Model<IStatusProbeStateDoc> {}

const StatusProbeStateSchema = new Schema<IStatusProbeStateDoc>(
  {
    probeKey: { type: String, required: true },
    componentKey: { type: String, required: true },
    state: { type: String, enum: DISPLAY_STATES, required: true },
    fails: { type: Number, required: true, default: 0 },
    degradeds: { type: Number, required: true, default: 0 },
    passes: { type: Number, required: true, default: 0 },
    lastResultAt: { type: Date, required: true },
    lastRunScheduledAt: { type: Date, required: true },
    lastChangeAt: { type: Date, required: true },
    lastErrorClass: { type: String },
  },
  { collection: 'statusProbeStates' }
);

// Unique index is built by the status-page-indexes migration.
StatusProbeStateSchema.index({ probeKey: 1 }, { unique: true });

export const StatusProbeState: IStatusProbeStateModel =
  (mongoose.models[ModelName] as IStatusProbeStateModel) ||
  model<IStatusProbeStateDoc, IStatusProbeStateModel>(ModelName, StatusProbeStateSchema);
