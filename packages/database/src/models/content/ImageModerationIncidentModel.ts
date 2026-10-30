import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type { ImageModerationIncident as ImageModerationIncidentData, IncidentReviewStatus } from '@bike4mind/common';
import { INCIDENT_REPORT_CHANNELS, INCIDENT_REVIEW_STATUSES, INCIDENT_SURFACES } from '@bike4mind/common';
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
    surface: { type: String, enum: INCIDENT_SURFACES, required: false },
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
    reportChannel: { type: String, enum: INCIDENT_REPORT_CHANNELS, required: false },
    reportedBy: { type: String, required: false },
    reportedAt: { type: Date, required: false },
    previousReviewStatus: { type: String, enum: ['false_positive'], required: false },
    falsePositiveBy: { type: String, required: false },
    falsePositiveAt: { type: Date, required: false },
    alertedAt: { type: Date, required: false },
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

export const ImageModerationIncident: Model<IImageModerationIncidentDocument> =
  (mongoose.models.ImageModerationIncident as mongoose.Model<IImageModerationIncidentDocument>) ||
  model<IImageModerationIncidentDocument>('ImageModerationIncident', ImageModerationIncidentSchema);

// A confirmed_csam claim older than this is treated as a stuck submission, not a live one.
export const STALE_CONFIRMED_CSAM_MS = 10 * 60 * 1000;

// Incidents awaiting a verdict. reviewStatus is absent on pre-Q3 rows, so `null` matches a
// missing field too. Shared so claimForNcmecSubmission and recordManualReport cannot diverge:
// both are the "unreviewed" predicate, and only one of them may win a given race.
const UNREVIEWED_REVIEW_STATUSES: (IncidentReviewStatus | null)[] = ['pending_review', null];

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

  /** Stamps the time the reviewer alert for this incident was delivered. */
  async markAlerted(id: string, alertedAt = new Date()): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { alertedAt } });
  }

  /** Returns unreviewed incidents (reviewStatus absent or 'pending_review'), oldest first. */
  async findPendingReview(limit: number): Promise<IImageModerationIncidentDocument[]> {
    return this.model
      .find({ reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES } })
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
    staleAfterMs = STALE_CONFIRMED_CSAM_MS
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
      { _id: id, reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES } },
      { $set: { reviewStatus: 'confirmed_csam' } },
      { new: true }
    );
  }

  /**
   * Record a CyberTip an admin filed by hand on the NCMEC web form. Transitions directly from
   * absent/pending_review to 'reported' in one atomic write, so it races cleanly with
   * claimForNcmecSubmission: whichever lands first wins and the other gets null.
   *
   * Also overrides a 'false_positive' verdict: the tip already exists at NCMEC, so the record
   * must say so, and previousReviewStatus keeps the earlier verdict visible. Never acts on
   * 'confirmed_csam' (an API submission owns it) or 'reported'.
   */
  async recordManualReport(
    id: string,
    report: { ncmecReportId: string; reportedBy: string }
  ): Promise<IImageModerationIncidentDocument | null> {
    const reported = {
      reviewStatus: 'reported',
      ncmecReportId: report.ncmecReportId,
      reportChannel: 'manual',
      reportedBy: report.reportedBy,
      reportedAt: new Date(),
    };
    const fromUnreviewed = await this.model.findOneAndUpdate(
      { _id: id, reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES } },
      { $set: reported },
      { new: true }
    );
    if (fromUnreviewed) return fromUnreviewed;
    // Each write is atomic on its own filter; a row can only match one of the two.
    return this.model.findOneAndUpdate(
      { _id: id, reviewStatus: 'false_positive' },
      { $set: { ...reported, previousReviewStatus: 'false_positive' } },
      { new: true }
    );
  }

  /**
   * Transition an incident to a terminal reviewStatus. `ncmecReportId` and the acting admin
   * (`reportedBy`, with `reportedAt`) are set when `status === 'reported'`; for 'false_positive'
   * the acting admin and time go to `falsePositiveBy`/`falsePositiveAt`. Returns null if the
   * transition is disallowed:
   * - always blocked when already 'reported' (idempotency)
   * - also blocked from 'confirmed_csam' when targeting 'false_positive', to prevent a
   *   concurrent false_positive verdict from overriding an in-flight NCMEC submission.
   */
  async updateReviewStatus(
    id: string,
    status: IncidentReviewStatus,
    ncmecReportId?: string,
    actorId?: string
  ): Promise<IImageModerationIncidentDocument | null> {
    const update: Record<string, unknown> = { reviewStatus: status };
    if (ncmecReportId) update.ncmecReportId = ncmecReportId;
    if (status === 'reported') {
      update.reportedAt = new Date();
      if (actorId) update.reportedBy = actorId;
    }
    if (status === 'false_positive') {
      update.falsePositiveAt = new Date();
      if (actorId) update.falsePositiveBy = actorId;
    }
    const excluded = status === 'false_positive' ? ['reported', 'confirmed_csam'] : ['reported'];
    return this.model.findOneAndUpdate({ _id: id, reviewStatus: { $nin: excluded } }, { $set: update }, { new: true });
  }

  /**
   * Admin recovery action for incidents stuck in 'confirmed_csam' after an unknown NCMEC
   * outcome. Transitions only from a stale 'confirmed_csam' (same threshold as
   * findStaleConfirmedCsam), so a live in-flight submission cannot be resolved under it.
   * Returns null if the incident is not in that state (wrong state, not found, still fresh,
   * or concurrent resolution).
   *
   *   { status: 'reported', ncmecReportId }  -- operator confirmed the tip was received
   *   { status: 'pending_review' }           -- operator confirmed nothing was filed; requeue.
   *                                             Refused when an ncmecReportId is stored: that
   *                                             report must be finalized, not filed again.
   */
  async resolveConfirmedCsam(
    id: string,
    target: { status: 'reported'; ncmecReportId: string; reportedBy: string } | { status: 'pending_review' },
    staleAfterMs = STALE_CONFIRMED_CSAM_MS
  ): Promise<IImageModerationIncidentDocument | null> {
    const update: Record<string, unknown> = { reviewStatus: target.status };
    if (target.status === 'reported') {
      update.ncmecReportId = target.ncmecReportId;
      update.reportedBy = target.reportedBy;
      update.reportedAt = new Date();
    }
    const filter: Record<string, unknown> = {
      _id: id,
      reviewStatus: 'confirmed_csam',
      updatedAt: { $lt: new Date(Date.now() - staleAfterMs) },
    };
    if (target.status === 'pending_review') filter.ncmecReportId = null;
    return this.model.findOneAndUpdate(filter, { $set: update }, { new: true });
  }

  /**
   * Persist a known reportId on a confirmed_csam incident without changing reviewStatus.
   * Stored after /finish fails so an admin can retry_finish within NCMEC's 24-hour window,
   * or after finalization succeeds but recording it fails so an admin can mark_reported
   * once the claim is stale. mark_reported records a finalized report without calling NCMEC.
   */
  async setNcmecReportId(id: string, ncmecReportId: string): Promise<void> {
    await this.model.updateOne({ _id: id, reviewStatus: 'confirmed_csam' }, { $set: { ncmecReportId } });
  }
}

export const imageModerationIncidentRepository = new ImageModerationIncidentRepository(ImageModerationIncident);
export default ImageModerationIncident;
