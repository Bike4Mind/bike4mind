import mongoose, { Model, Schema, model } from 'mongoose';
import {
  ALL_INCIDENT_STATUSES,
  COMPONENT_IMPACTS,
  INCIDENT_CLASSIFICATIONS,
  INCIDENT_KINDS,
  INCIDENT_SOURCES,
  MAX_INCIDENT_UPDATES,
  OVERALL_IMPACTS,
  PUBLIC_INCIDENT_ID_PATTERN,
  PUBLIC_UPDATE_ID_PATTERN,
  type StatusIncidentDoc,
} from '@bike4mind/common/status';

const ModelName = 'StatusIncident';

interface IStatusIncidentModel extends Model<StatusIncidentDoc> {}

const ImpactChangeSchema = new Schema(
  {
    from: { type: String, enum: OVERALL_IMPACTS, required: true },
    to: { type: String, enum: OVERALL_IMPACTS, required: true },
  },
  { _id: false }
);

const ComponentChangeSchema = new Schema(
  {
    componentKey: { type: String, required: true },
    from: { type: String, enum: [...COMPONENT_IMPACTS, null], default: null },
    to: { type: String, enum: [...COMPONENT_IMPACTS, null], default: null },
  },
  { _id: false }
);

const EditHistorySchema = new Schema(
  {
    at: { type: Date, required: true },
    editorId: { type: String, required: true },
    body: { type: String, required: true },
  },
  { _id: false }
);

const UpdateSchema = new Schema(
  {
    updateId: { type: String, required: true, match: PUBLIC_UPDATE_ID_PATTERN },
    at: { type: Date, required: true },
    status: { type: String, enum: ALL_INCIDENT_STATUSES, required: true },
    body: { type: String, required: true },
    authorId: { type: String, required: true },
    impactChange: { type: ImpactChangeSchema },
    componentChanges: { type: [ComponentChangeSchema], default: undefined },
    editedAt: { type: Date },
    editHistory: { type: [EditHistorySchema], default: [] },
  },
  { _id: false }
);

const IncidentComponentSchema = new Schema(
  {
    componentKey: { type: String, required: true },
    impact: { type: String, enum: COMPONENT_IMPACTS, required: true },
  },
  { _id: false }
);

const InternalNoteSchema = new Schema(
  {
    at: { type: Date, required: true },
    authorId: { type: String, required: true },
    body: { type: String, required: true },
  },
  { _id: false }
);

const PostmortemSchema = new Schema(
  {
    url: { type: String },
    body: { type: String },
    publishedAt: { type: Date },
  },
  { _id: false }
);

const DetectionSchema = new Schema(
  {
    firstFailureAt: { type: Date, required: true },
    probeKeys: { type: [String], default: [] },
    upstream: { type: String },
  },
  { _id: false }
);

const BreakGlassSchema = new Schema(
  {
    journalKeys: { type: [String], default: [] },
    actorIds: { type: [String], default: [] },
    firstWrittenAt: { type: Date, required: true },
    backdateConfirmedBy: { type: String },
  },
  { _id: false }
);

const RetractedSchema = new Schema(
  {
    at: { type: Date, required: true },
    by: { type: String, required: true },
    reason: { type: String, required: true },
  },
  { _id: false }
);

const PlannedMessagesSchema = new Schema({ start: { type: String }, end: { type: String } }, { _id: false });

const StatusIncidentSchema = new Schema<StatusIncidentDoc>(
  {
    publicId: { type: String, required: true, match: PUBLIC_INCIDENT_ID_PATTERN },
    kind: { type: String, enum: INCIDENT_KINDS, required: true },
    published: { type: Boolean, required: true, default: false },
    firstPublishedAt: { type: Date },
    detectedAt: { type: Date },
    source: { type: String, enum: INCIDENT_SOURCES, required: true },
    classification: { type: String, enum: INCIDENT_CLASSIFICATIONS, required: true, default: 'standard' },
    title: { type: String, required: true },
    status: { type: String, enum: ALL_INCIDENT_STATUSES, required: true },
    impact: { type: String, enum: OVERALL_IMPACTS, required: true },
    components: { type: [IncidentComponentSchema], default: [] },
    startedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    scheduledStartAt: { type: Date },
    scheduledEndAt: { type: Date },
    completedEarlyAt: { type: Date },
    cancelledAt: { type: Date },
    announcedAt: { type: Date },
    plannedMessages: { type: PlannedMessagesSchema },
    updates: {
      type: [UpdateSchema],
      default: [],
      // Checked on save only: a writer that appends with an update operator must guard the length itself.
      validate: {
        validator: (updates: unknown[]) => updates.length <= MAX_INCIDENT_UPDATES,
        message: `An incident holds at most ${MAX_INCIDENT_UPDATES} updates`,
      },
    },
    internalNotes: { type: [InternalNoteSchema], default: [] },
    postmortem: { type: PostmortemSchema },
    postmortemDueAt: { type: Date },
    detection: { type: DetectionSchema },
    breakGlass: { type: BreakGlassSchema },
    retracted: { type: RetractedSchema },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: String, required: true },
  },
  { collection: 'statusIncidents', timestamps: true }
);

// The unique index is built by the status-page-indexes migration.
StatusIncidentSchema.index({ publicId: 1 }, { unique: true });
StatusIncidentSchema.index({ published: 1, status: 1, startedAt: -1 });
StatusIncidentSchema.index({ kind: 1, scheduledStartAt: 1 });

export const StatusIncident: IStatusIncidentModel =
  (mongoose.models[ModelName] as IStatusIncidentModel) ||
  model<StatusIncidentDoc, IStatusIncidentModel>(ModelName, StatusIncidentSchema);
