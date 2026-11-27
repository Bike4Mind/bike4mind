import mongoose, { Model, Schema, model } from 'mongoose';
import { COMPONENT_STATES, type ComponentState } from '@bike4mind/common/status';

const ModelName = 'StatusOverride';

export const STATUS_OVERRIDE_KINDS = ['pin', 'suppress'] as const;
export type StatusOverrideKind = (typeof STATUS_OVERRIDE_KINDS)[number];

export interface IStatusOverrideDoc {
  componentKey: string;
  kind: StatusOverrideKind;
  state?: ComponentState;
  from: Date;
  to: Date;
  reason: string;
  actorId: string;
  clearedAt?: Date;
  clearedBy?: string;
}

interface IStatusOverrideModel extends Model<IStatusOverrideDoc> {}

const StatusOverrideSchema = new Schema<IStatusOverrideDoc>(
  {
    componentKey: { type: String, required: true },
    kind: { type: String, enum: STATUS_OVERRIDE_KINDS, required: true },
    state: { type: String, enum: COMPONENT_STATES },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    reason: { type: String, required: true },
    actorId: { type: String, required: true },
    clearedAt: { type: Date },
    clearedBy: { type: String },
  },
  { collection: 'statusOverrides' }
);

StatusOverrideSchema.index({ componentKey: 1, from: -1 });

export const StatusOverride: IStatusOverrideModel =
  (mongoose.models[ModelName] as IStatusOverrideModel) ||
  model<IStatusOverrideDoc, IStatusOverrideModel>(ModelName, StatusOverrideSchema);
