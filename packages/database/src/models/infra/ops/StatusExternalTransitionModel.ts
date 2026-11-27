import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'StatusExternalTransition';

export const STATUS_EXTERNAL_TRANSITION_RETENTION_DAYS = 400;

export const STATUS_EXTERNAL_STATES = ['up', 'down', 'unknown'] as const;
export type StatusExternalState = (typeof STATUS_EXTERNAL_STATES)[number];

export interface IStatusExternalTransitionDoc {
  at: Date;
  state: StatusExternalState;
  sourceKey: string;
  expiresAt: Date;
}

interface IStatusExternalTransitionModel extends Model<IStatusExternalTransitionDoc> {}

const StatusExternalTransitionSchema = new Schema<IStatusExternalTransitionDoc>(
  {
    at: { type: Date, required: true },
    state: { type: String, enum: STATUS_EXTERNAL_STATES, required: true },
    sourceKey: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'statusExternalTransitions' }
);

// The unique index is built by the status-page-indexes migration.
StatusExternalTransitionSchema.index({ sourceKey: 1 }, { unique: true });
StatusExternalTransitionSchema.index({ at: 1 });
StatusExternalTransitionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StatusExternalTransition: IStatusExternalTransitionModel =
  (mongoose.models[ModelName] as IStatusExternalTransitionModel) ||
  model<IStatusExternalTransitionDoc, IStatusExternalTransitionModel>(ModelName, StatusExternalTransitionSchema);
