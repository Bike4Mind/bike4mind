import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'StatusProbeResult';

export const STATUS_PROBE_RESULT_RETENTION_DAYS = 7;

export interface IStatusProbeResultDoc {
  probeKey: string;
  componentKey: string;
  tier: string;
  at: Date;
  scheduledAt: Date;
  outcome: string;
  latencyMs?: number;
  statusCode?: number;
  errorClass?: string;
  /** At most 500 characters, secret-scrubbed, never a response body. */
  errorDetail?: string;
  costUsd?: number;
  expiresAt: Date;
}

interface IStatusProbeResultModel extends Model<IStatusProbeResultDoc> {}

const StatusProbeResultSchema = new Schema<IStatusProbeResultDoc>(
  {
    probeKey: { type: String, required: true },
    componentKey: { type: String, required: true },
    tier: { type: String, required: true },
    at: { type: Date, required: true },
    scheduledAt: { type: Date, required: true },
    outcome: { type: String, required: true },
    latencyMs: { type: Number },
    statusCode: { type: Number },
    errorClass: { type: String },
    errorDetail: { type: String, maxlength: 500 },
    costUsd: { type: Number },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'statusProbeResults' }
);

StatusProbeResultSchema.index({ probeKey: 1, at: -1 });
StatusProbeResultSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StatusProbeResult: IStatusProbeResultModel =
  (mongoose.models[ModelName] as IStatusProbeResultModel) ||
  model<IStatusProbeResultDoc, IStatusProbeResultModel>(ModelName, StatusProbeResultSchema);
