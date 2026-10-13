import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type { ImageModerationIncident as ImageModerationIncidentData, IncidentReviewStatus } from '@bike4mind/common';
import { INCIDENT_REVIEW_STATUSES } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * ImageModerationIncident - one row per generated image blocked by auto-moderation.
 * Metadata-only audit trail (no image bytes; byte preservation for section 2258A
 * is Quest 3). Retention: kept indefinitely (moderation/legal audit), no TTL.
 */
// `Omit<Document, 'model'>`: the data field `model` (the generation model name,
// e.g. 'flux-pro-1.1') collides with mongoose `Document.model()` (an instance
// method for looking up sibling models). Without the omit, TS raises TS2320
// ("cannot simultaneously extend" - the two `model` members have incompatible
// types) because the string field and the method can't coexist on one interface.
export interface IImageModerationIncidentDocument
  extends Omit<ImageModerationIncidentData, 'createdAt' | 'updatedAt'>, Omit<Document, 'model'> {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

const ImageModerationIncidentSchema = new Schema(
  {
    userId: { type: String, required: true },
    // Not required: agent-tool callers (image_generation/edit_image tools) have no questId,
    // and some tool harnesses have no sessionId either. Queue-handler callers
    // (ImageGeneration/ImageEdit services) still always pass both.
    sessionId: { type: String },
    questId: { type: String },
    fabFileId: { type: String, required: false },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    labels: [
      {
        _id: false,
        name: { type: String, required: true },
        parentName: { type: String, default: '' },
        confidence: { type: Number, required: true },
      },
    ],
    // Absent on pre-Q3 incidents; treated as 'pending_review' by all queries.
    reviewStatus: { type: String, enum: INCIDENT_REVIEW_STATUSES, required: false },
    // Populated when reviewStatus === 'reported'. The CyberTipline report ID returned by NCMEC.
    ncmecReportId: { type: String, required: false },
  },
  {
    timestamps: true,
    collection: 'image_moderation_incidents',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes (per MongoDB Index Guidelines)
ImageModerationIncidentSchema.index({ userId: 1, createdAt: -1 }); // per-user history
ImageModerationIncidentSchema.index({ createdAt: -1 }); // moderation queue
// Admin triage queue: absent reviewStatus (pre-Q3) sorts alongside 'pending_review' via $in query.
ImageModerationIncidentSchema.index({ reviewStatus: 1, createdAt: 1 });

export const ImageModerationIncident =
  (mongoose.models.ImageModerationIncident as mongoose.Model<IImageModerationIncidentDocument>) ||
  model<IImageModerationIncidentDocument>('ImageModerationIncident', ImageModerationIncidentSchema);

export class ImageModerationIncidentRepository extends BaseRepository<IImageModerationIncidentDocument> {
  constructor(model: Model<IImageModerationIncidentDocument>) {
    super(model);
  }

  /**
   * Record a block incident (audit trail).
   *
   * Bypasses the generic `BaseRepository.create()` - that method's parameter
   * type is `Omit<T, 'id' | 'updatedAt' | 'createdAt'>`, and here `T`
   * (`IImageModerationIncidentDocument`) also extends mongoose's `Document`,
   * so the omit still requires every `Document` instance method. Calling
   * `this.model.create()` directly accepts the plain input data instead.
   *
   * Returns the hydrated document as-is rather than `.toJSON()`/`.toObject()`:
   * casting a flattened (`FlattenMaps<...>`) result back to
   * `IImageModerationIncidentDocument` fails to typecheck (TS2352) because
   * `FlattenMaps` recurses into every `Document` member - including driver
   * internals like `collection.db.client` - producing a shape that no longer
   * structurally matches the real `MongoClient` type.
   */
  async record(input: ImageModerationIncidentData): Promise<IImageModerationIncidentDocument> {
    return this.model.create(input);
  }

  /** Returns unreviewed incidents (reviewStatus absent or 'pending_review'), oldest first. */
  async findPendingReview(limit: number): Promise<IImageModerationIncidentDocument[]> {
    return this.model
      .find({ reviewStatus: { $in: ['pending_review', null] } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean() as unknown as IImageModerationIncidentDocument[];
  }

  /**
   * Returns incidents stuck in 'confirmed_csam' for longer than staleAfterMs (default 10 min).
   * These are claims where the NCMEC HTTP call had an unknown outcome (timeout, network error)
   * and the verdict route deliberately left the incident unclaimed for human verification.
   * The admin should check NCMEC before retrying to avoid duplicate CyberTip submissions.
   */
  async findStaleConfirmedCsam(
    limit: number,
    staleAfterMs = 10 * 60 * 1000
  ): Promise<IImageModerationIncidentDocument[]> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    return this.model
      .find({ reviewStatus: 'confirmed_csam', updatedAt: { $lt: cutoff } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean() as unknown as IImageModerationIncidentDocument[];
  }

  /**
   * Atomically claim an incident for NCMEC submission. Transitions from absent/pending_review
   * to 'confirmed_csam'. Only one concurrent request can succeed for a given incident; all
   * others get null, preventing duplicate NCMEC filings.
   */
  async claimForNcmecSubmission(id: string): Promise<IImageModerationIncidentDocument | null> {
    return this.model.findOneAndUpdate(
      { _id: id, reviewStatus: { $in: ['pending_review', null] } },
      { $set: { reviewStatus: 'confirmed_csam' } },
      { new: true }
    );
  }

  /**
   * Transition an incident to a terminal reviewStatus. `ncmecReportId` is set when
   * `status === 'reported'`. Returns null if the transition is disallowed:
   * - always blocked when already 'reported' (idempotency)
   * - also blocked from 'confirmed_csam' when targeting 'false_positive', to prevent a
   *   concurrent false_positive verdict from overriding an in-flight NCMEC submission.
   */
  async updateReviewStatus(
    id: string,
    status: IncidentReviewStatus,
    ncmecReportId?: string
  ): Promise<IImageModerationIncidentDocument | null> {
    const update: Record<string, unknown> = { reviewStatus: status };
    if (ncmecReportId) update.ncmecReportId = ncmecReportId;
    const excluded = status === 'false_positive' ? ['reported', 'confirmed_csam'] : ['reported'];
    return this.model.findOneAndUpdate(
      { _id: id, reviewStatus: { $nin: excluded } },
      { $set: update },
      { new: true }
    );
  }

  /**
   * Admin recovery action for incidents stuck in 'confirmed_csam' after an unknown NCMEC
   * outcome. Transitions only from 'confirmed_csam'. Returns null if the incident is not
   * in that state (wrong state, not found, or concurrent resolution).
   *
   *   { status: 'reported', ncmecReportId }  -- operator confirmed the tip was received
   *   { status: 'pending_review' }           -- operator confirmed nothing was filed; requeue
   */
  async resolveConfirmedCsam(
    id: string,
    target: { status: 'reported'; ncmecReportId: string } | { status: 'pending_review' }
  ): Promise<IImageModerationIncidentDocument | null> {
    const update: Record<string, unknown> = { reviewStatus: target.status };
    if (target.status === 'reported') update.ncmecReportId = target.ncmecReportId;
    return this.model.findOneAndUpdate(
      { _id: id, reviewStatus: 'confirmed_csam' },
      { $set: update },
      { new: true }
    );
  }

  /**
   * Persist a known reportId on a confirmed_csam incident without changing reviewStatus.
   * Called when /finish fails after a successful /submit: the reportId is known and should
   * be stored so an admin can use 'mark_reported' to finalize within NCMEC's 24-hour window.
   */
  async setNcmecReportId(id: string, ncmecReportId: string): Promise<void> {
    await this.model.updateOne(
      { _id: id, reviewStatus: 'confirmed_csam' },
      { $set: { ncmecReportId } }
    );
  }
}

export const imageModerationIncidentRepository = new ImageModerationIncidentRepository(ImageModerationIncident);
export default ImageModerationIncident;
