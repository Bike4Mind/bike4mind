import mongoose, { Model, Schema, model } from 'mongoose';
import {
  COMPONENT_MONITORING,
  COMPONENT_SOURCES,
  COMPONENT_VISIBILITIES,
  PUBLIC_SLUG_PATTERN,
  type StatusComponentDoc,
} from '@bike4mind/common/status';

const ModelName = 'StatusComponent';

interface IStatusComponentModel extends Model<StatusComponentDoc> {}

const VendorSchema = new Schema(
  {
    key: { type: String, required: true },
    displayName: { type: String, required: true },
    statusPageUrl: { type: String, required: true },
    publicNaming: { type: Boolean, required: true },
  },
  { _id: false }
);

const HysteresisSchema = new Schema(
  {
    fail: { type: Number, required: true },
    recover: { type: Number, required: true },
  },
  { _id: false }
);

const StatusComponentSchema = new Schema<StatusComponentDoc>(
  {
    key: { type: String, required: true },
    publicSlug: { type: String, required: true, match: PUBLIC_SLUG_PATTERN },
    source: { type: String, enum: COMPONENT_SOURCES, required: true },
    contributorId: { type: String },
    name: { type: String, required: true },
    description: { type: String },
    group: { type: String, required: true },
    order: { type: Number, required: true },
    visibility: { type: String, enum: COMPONENT_VISIBILITIES, required: true },
    monitoring: { type: String, enum: COMPONENT_MONITORING, required: true },
    vendor: { type: VendorSchema },
    externallyMonitored: { type: Boolean, required: true },
    probeKeys: { type: [String], default: [] },
    hysteresis: { type: HysteresisSchema },
    retiredAt: { type: Date },
    parentKey: { type: String },
  },
  { collection: 'statusComponents', timestamps: true }
);

// Unique indexes are built by the status-page-indexes migration.
StatusComponentSchema.index({ key: 1 }, { unique: true });
StatusComponentSchema.index({ publicSlug: 1 }, { unique: true });

export const StatusComponent: IStatusComponentModel =
  (mongoose.models[ModelName] as IStatusComponentModel) ||
  model<StatusComponentDoc, IStatusComponentModel>(ModelName, StatusComponentSchema);
