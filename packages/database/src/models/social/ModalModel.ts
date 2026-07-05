import mongoose, { Model, Schema, model } from 'mongoose';
import { IModalDocument } from '@bike4mind/common';
import { IndividualCounterSchema } from '../infra/ops/CounterModel';

const ModalImageSchema = new Schema({
  url: { type: String, required: true },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
});

/**
 * Embedded schema for generation metadata.
 * Only populated for auto-generated modals (e.g., What's New).
 * Null/undefined for manually created modals and banners.
 */
const GenerationMetadataSchema = new Schema(
  {
    /** Date for daily batch generation (YYYY-MM-DD format) */
    generatedDate: { type: String },
    /** Array of release tags included in this modal */
    releases: { type: [String] },
    /** Single release tag (backward compatibility) */
    releaseTag: { type: String },
    /** Correlation ID for tracing the generation request */
    correlationId: { type: String, required: true },
    /** LLM model used for generation */
    modelUsed: { type: String, required: true },
    /** Environment where the modal was generated */
    environment: { type: String, enum: ['dev', 'production'], required: true },
    /** Timestamp when the modal was generated */
    generatedAt: { type: Date, required: true },
    /** Source modal ID from production (for fork-imported modals) */
    sourceModalId: { type: String },
    /** Origin of the modal - 'production' for imported, 'self' for locally generated */
    importedFrom: { type: String, enum: ['production', 'self'] },
    /** Content hash from production S3 at time of import (for edit detection during sync) */
    sourceContentHash: { type: String },
    /** Timestamp when the modal was last synced from production */
    lastSyncedAt: { type: Date },
  },
  { _id: false }
);

const ModalSchema = new Schema<IModalDocument>(
  {
    title: { type: String, default: null },
    subtitle: { type: String, default: null },
    description: { type: String, default: null },
    imageUrl: { type: String, default: null },
    images: [ModalImageSchema],
    textMessage: { type: String, default: null },
    isBanner: { type: Boolean, default: false },
    tags: { type: [String], default: null },
    priority: { type: Number, default: 0 },
    closeButton: { type: Boolean, default: true },
    agreeButton: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    startDate: { type: String, default: null },
    endDate: { type: String, default: null },
    numberOfAgrees: { type: IndividualCounterSchema, default: null },
    numberOfViews: { type: IndividualCounterSchema, default: null },
    /** Generation metadata for auto-generated modals (null for manual modals) */
    generationMetadata: { type: GenerationMetadataSchema, default: null },
    /**
     * Per-audience variant content map. Keys are AudienceKey values ('internal' | 'customer').
     * Stripped at serve time by extractVariantForViewer - never returned to clients.
     * Absent on legacy / non-variant modals.
     */
    variants: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Index for efficient querying of What's New modals
// Used by whatsNewGeneration.ts to fetch previous modals for style learning
ModalSchema.index({ tags: 1, enabled: 1, startDate: -1 });

// Partial unique index for idempotency: no duplicate auto-generated modals per
// date/environment. Only applies when generationMetadata.generatedDate is set.
ModalSchema.index(
  { 'generationMetadata.generatedDate': 1, 'generationMetadata.environment': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'generationMetadata.generatedDate': { $exists: true, $ne: null },
    },
    name: 'generation_date_environment_unique',
  }
);

// Sparse unique index for fork-imported modals
// Prevents duplicate imports from production by sourceModalId
// Only indexes documents where sourceModalId exists
ModalSchema.index(
  { 'generationMetadata.sourceModalId': 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      'generationMetadata.sourceModalId': { $exists: true, $ne: null },
    },
    name: 'source_modal_id_unique',
  }
);

// Sparse index for admin queries filtering by import source
// Used by admin UI to filter modals by importedFrom (production vs self)
ModalSchema.index(
  { 'generationMetadata.importedFrom': 1 },
  {
    sparse: true,
    name: 'imported_from_index',
  }
);

// Compound index for sync query efficiency
// Used by syncExistingModals() to find all production-imported modals
ModalSchema.index(
  { 'generationMetadata.sourceModalId': 1, 'generationMetadata.importedFrom': 1 },
  {
    sparse: true,
    partialFilterExpression: {
      'generationMetadata.sourceModalId': { $exists: true, $ne: null },
      'generationMetadata.importedFrom': 'production',
    },
    name: 'sync_query_index',
  }
);

export const ModalModel: Model<IModalDocument> = mongoose.models.Modal ?? model<IModalDocument>('Modal', ModalSchema);
export default ModalModel;
