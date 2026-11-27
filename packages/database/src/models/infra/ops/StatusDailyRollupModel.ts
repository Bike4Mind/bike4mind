import mongoose, { Model, Schema, model } from 'mongoose';
import { BAR_CODES, type BarCode } from '@bike4mind/common/status';

const ModelName = 'StatusDailyRollup';

export const STATUS_DAILY_ROLLUP_RETENTION_DAYS = 400;

export interface IStatusDailyRollupDoc {
  componentKey: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  seconds: {
    operational: number;
    degraded: number;
    partial: number;
    major: number;
    maintenanceExcluded: number;
    unknown: number;
  };
  observedSeconds: number;
  downtimeSeconds: number;
  /** Null when the day has no data. */
  uptime: number | null;
  barState: BarCode;
  /** Published, non-retracted incidents only. */
  incidentIds: string[];
  computedAt: Date;
  expiresAt: Date;
}

interface IStatusDailyRollupModel extends Model<IStatusDailyRollupDoc> {}

const seconds = { type: Number, required: true, default: 0 };

const StatusDailyRollupSchema = new Schema<IStatusDailyRollupDoc>(
  {
    componentKey: { type: String, required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    seconds: {
      operational: seconds,
      degraded: seconds,
      partial: seconds,
      major: seconds,
      maintenanceExcluded: seconds,
      unknown: seconds,
    },
    observedSeconds: { type: Number, required: true },
    downtimeSeconds: { type: Number, required: true },
    uptime: { type: Number, default: null },
    barState: { type: String, enum: BAR_CODES, required: true },
    incidentIds: { type: [String], default: [] },
    computedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'statusDailyRollups' }
);

// The unique index is built by the status-page-indexes migration.
StatusDailyRollupSchema.index({ componentKey: 1, day: 1 }, { unique: true });
StatusDailyRollupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StatusDailyRollup: IStatusDailyRollupModel =
  (mongoose.models[ModelName] as IStatusDailyRollupModel) ||
  model<IStatusDailyRollupDoc, IStatusDailyRollupModel>(ModelName, StatusDailyRollupSchema);
