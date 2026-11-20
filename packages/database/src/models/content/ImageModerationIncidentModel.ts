import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type {
  EmailDeliveryOutcome,
  ImageModerationIncident as ImageModerationIncidentData,
  IncidentReviewStatus,
} from '@bike4mind/common';
import {
  INCIDENT_ESCALATION_TRIGGERS,
  INCIDENT_OVERRIDABLE_REVIEW_STATUSES,
  INCIDENT_REPORT_CHANNELS,
  INCIDENT_REVIEW_STATUSES,
  INCIDENT_SURFACES,
} from '@bike4mind/common';
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
    previousReviewStatus: { type: String, enum: INCIDENT_OVERRIDABLE_REVIEW_STATUSES, required: false },
    falsePositiveBy: { type: String, required: false },
    falsePositiveAt: { type: Date, required: false },
    noActionBy: { type: String, required: false },
    noActionAt: { type: Date, required: false },
    alertedAt: { type: Date, required: false },
    alertQueuedAt: { type: Date, required: false },
    alertFailedAt: { type: Date, required: false },
    lastReminderAt: { type: Date, required: false },
    escalatedAt: { type: Date, required: false },
    escalatedBy: { type: String, required: false },
    escalationTrigger: { type: String, enum: INCIDENT_ESCALATION_TRIGGERS, required: false },
    escalationAlertedAt: { type: Date, required: false },
    escalationAlertQueuedAt: { type: Date, required: false },
    escalationAlertFailedAt: { type: Date, required: false },
    escalationLastReminderAt: { type: Date, required: false },
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

// Incidents with a final verdict, for looking past verdicts up. confirmed_csam is a claim in
// flight, not a verdict, so it is neither here nor in the unreviewed set.
export const CLOSED_REVIEW_STATUSES: IncidentReviewStatus[] = ['false_positive', 'no_action', 'reported'];

/** Counts for the review page summary; never ids, users or labels. */
export interface ImageModerationIncidentSummary {
  /** reviewStatus absent or 'pending_review'. */
  needsReview: number;
  /** Of needsReview, the ones moved to the second review step. */
  escalated: number;
  /** In 'confirmed_csam': a report submission claimed and not yet resolved. */
  stuck: number;
  closed: { noAction: number; falsePositive: number; reported: number };
  oldestPendingCreatedAt: Date | null;
}

const SUMMARY_MAX_TIME_MS = 2000;

/**
 * A queued alert is no longer in flight once a copy failed after it was queued and `queuedBefore`
 * has passed (the worker's retries are spent), or once it was queued before `lostBefore` with no
 * outcome at all.
 */
const notInFlight = (queued: string, failed: string, queuedBefore: Date, lostBefore: Date) => [
  { [queued]: null },
  { [queued]: { $lte: lostBefore } },
  { [queued]: { $lte: queuedBefore }, $expr: { $gte: [`$${failed}`, `$${queued}`] } },
];

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

  /** Stamps the time the reviewer alert was queued for the email-send worker; not a delivery. */
  async markAlertQueued(id: string, alertQueuedAt = new Date()): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { alertQueuedAt } }, { runValidators: true });
  }

  /**
   * Records the email-send worker's outcome for one reviewer's copy of an alert. The first delivered
   * copy stamps the delivery time and later ones (other reviewers, replays) leave it, unless the round
   * was voided (voidAlertRound). A failure only stamps the failure time: a reviewer whose copy always
   * fails (a rejected or sink address) must not make every round resend to all reviewers.
   */
  async recordAlertDelivery(
    id: string,
    alert: 'review' | 'escalation',
    outcome: EmailDeliveryOutcome,
    now = new Date()
  ): Promise<void> {
    const [delivered, queued, failed] =
      alert === 'review'
        ? ['alertedAt', 'alertQueuedAt', 'alertFailedAt']
        : ['escalationAlertedAt', 'escalationAlertQueuedAt', 'escalationAlertFailedAt'];
    if (outcome.ok) {
      await this.model.updateOne(
        {
          _id: id,
          [delivered]: null,
          $nor: [{ [queued]: null, [failed]: { $ne: null } }],
        },
        { $set: { [delivered]: outcome.at } },
        { runValidators: true }
      );
    } else {
      await this.model.updateOne({ _id: id }, { $set: { [failed]: now } }, { runValidators: true });
    }
  }

  /**
   * Voids a round in which some reviewer's copy could not be queued. The copies that were queued still
   * report back; with the queue stamp cleared their delivery cannot close the round (recordAlertDelivery),
   * and a delivery stamped at or after `roundStart` is cleared, so the sweep resends to every reviewer.
   * An earlier round's stamp predates `roundStart` and stays.
   */
  async voidAlertRound(id: string, alert: 'review' | 'escalation', roundStart: Date, now = new Date()): Promise<void> {
    const [delivered, queued, failed] =
      alert === 'review'
        ? ['alertedAt', 'alertQueuedAt', 'alertFailedAt']
        : ['escalationAlertedAt', 'escalationAlertQueuedAt', 'escalationAlertFailedAt'];
    // Unqueue first: a copy delivered after this write can no longer stamp, so the clear below is final.
    await this.model.updateOne(
      { _id: id },
      { $set: { [failed]: now }, $unset: { [queued]: 1 } },
      { runValidators: true }
    );
    await this.model.updateOne(
      { _id: id, [delivered]: { $gte: roundStart } },
      { $unset: { [delivered]: 1 } },
      { runValidators: true }
    );
  }

  /** Stamps the time a reminder digest covered these still-unreviewed incidents. */
  async markReminded(ids: string[], lastReminderAt = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.model.updateMany({ _id: { $in: ids } }, { $set: { lastReminderAt } });
  }

  /** Number of unreviewed incidents (reviewStatus absent or 'pending_review'). */
  async countPendingReview(options: { limit?: number } = {}): Promise<number> {
    return this.model.countDocuments({ reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES } }, { limit: options.limit });
  }

  async oldestPendingReviewAt(): Promise<Date | null> {
    const row = await this.model
      .findOne({ reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES } })
      .sort({ createdAt: 1 })
      .select({ createdAt: 1 })
      .maxTimeMS(2000)
      .lean();
    return row?.createdAt ?? null;
  }

  /**
   * One count per status, each led by reviewStatus so it runs on the {reviewStatus, createdAt}
   * index; only the escalated count reads documents, and only the unreviewed ones.
   */
  async summarize(): Promise<ImageModerationIncidentSummary> {
    const count = (filter: Record<string, unknown>) =>
      this.model.countDocuments(filter).maxTimeMS(SUMMARY_MAX_TIME_MS).exec();
    const unreviewed = { reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES } };
    const [needsReview, escalated, stuck, noAction, falsePositive, reported, oldestPendingCreatedAt] =
      await Promise.all([
        count(unreviewed),
        count({ ...unreviewed, escalatedAt: { $ne: null } }),
        count({ reviewStatus: 'confirmed_csam' }),
        count({ reviewStatus: 'no_action' }),
        count({ reviewStatus: 'false_positive' }),
        count({ reviewStatus: 'reported' }),
        this.oldestPendingReviewAt(),
      ]);
    return { needsReview, escalated, stuck, closed: { noAction, falsePositive, reported }, oldestPendingCreatedAt };
  }

  /**
   * Unreviewed incidents created at or before `createdBefore` that no alert has been delivered
   * for, oldest first, skipping one whose queued alert may still be in flight (see notInFlight).
   */
  async findUnalerted(
    createdBefore: Date,
    limit: number,
    queuedBefore: Date,
    lostBefore: Date
  ): Promise<IImageModerationIncidentDocument[]> {
    return this.model
      .find({
        reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES },
        alertedAt: null,
        createdAt: { $lte: createdBefore },
        $or: notInFlight('alertQueuedAt', 'alertFailedAt', queuedBefore, lostBefore),
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean() as unknown as IImageModerationIncidentDocument[];
  }

  /**
   * Unreviewed incidents that were alerted and are due another reminder: both the alert and the
   * last reminder (when there is one) are at or before `notifiedBefore`. Oldest first.
   */
  async findDueForReminder(notifiedBefore: Date, limit: number): Promise<IImageModerationIncidentDocument[]> {
    return this.model
      .find({
        reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES },
        alertedAt: { $ne: null, $lte: notifiedBefore },
        $or: [{ lastReminderAt: null }, { lastReminderAt: { $lte: notifiedBefore } }],
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean() as unknown as IImageModerationIncidentDocument[];
  }

  /** Unreviewed incidents created at or before `createdBefore` that are not escalated yet, oldest first. */
  async findDueForEscalation(createdBefore: Date, limit: number): Promise<IImageModerationIncidentDocument[]> {
    return this.model
      .find({
        reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES },
        escalatedAt: null,
        createdAt: { $lte: createdBefore },
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean() as unknown as IImageModerationIncidentDocument[];
  }

  /**
   * Escalated incidents still awaiting a verdict with no delivered escalation email, oldest first,
   * skipping one whose queued escalation email may still be in flight (see notInFlight).
   */
  async findEscalationUnalerted(
    limit: number,
    queuedBefore: Date,
    lostBefore: Date
  ): Promise<IImageModerationIncidentDocument[]> {
    return this.model
      .find({
        reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES },
        escalatedAt: { $ne: null },
        escalationAlertedAt: null,
        $or: notInFlight('escalationAlertQueuedAt', 'escalationAlertFailedAt', queuedBefore, lostBefore),
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean() as unknown as IImageModerationIncidentDocument[];
  }

  /**
   * Moves an unreviewed incident to the second review step without touching reviewStatus. Atomic on
   * its filter: only an unreviewed, not yet escalated incident matches, so of two concurrent
   * escalations one wins and the other gets null, as does an incident with a verdict or none at all.
   */
  async escalate(
    id: string,
    escalation: { trigger: 'manual'; by: string } | { trigger: 'timeout' },
    at = new Date()
  ): Promise<IImageModerationIncidentDocument | null> {
    return this.model.findOneAndUpdate(
      { _id: id, reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES }, escalatedAt: null },
      {
        $set: {
          escalatedAt: at,
          escalationTrigger: escalation.trigger,
          ...(escalation.trigger === 'manual' ? { escalatedBy: escalation.by } : {}),
        },
      },
      { new: true, runValidators: true }
    );
  }

  /** Stamps the time the escalation email for this incident was delivered. */
  async markEscalationAlerted(id: string, escalationAlertedAt = new Date()): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { escalationAlertedAt } });
  }

  /** Stamps the time the escalation email was queued for the email-send worker; not a delivery. */
  async markEscalationAlertQueued(id: string, escalationAlertQueuedAt = new Date()): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { escalationAlertQueuedAt } }, { runValidators: true });
  }

  /**
   * Escalated incidents still awaiting a verdict that are due another reminder to the second
   * reviewers: both the escalation email and the last escalation reminder (when there is one) are at
   * or before `notifiedBefore`. Oldest first.
   */
  async findDueForEscalationReminder(notifiedBefore: Date, limit: number): Promise<IImageModerationIncidentDocument[]> {
    return this.model
      .find({
        reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES },
        escalationAlertedAt: { $ne: null, $lte: notifiedBefore },
        $or: [{ escalationLastReminderAt: null }, { escalationLastReminderAt: { $lte: notifiedBefore } }],
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean() as unknown as IImageModerationIncidentDocument[];
  }

  /** Stamps the time a reminder digest to the second reviewers covered these incidents. */
  async markEscalationReminded(ids: string[], escalationLastReminderAt = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.model.updateMany({ _id: { $in: ids } }, { $set: { escalationLastReminderAt } });
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
   * Incidents with a final verdict (see CLOSED_REVIEW_STATUSES), newest first. `before` pages
   * back: only incidents created strictly before it, or created at `before` with an id below
   * `beforeId` (so rows sharing one createdAt are neither skipped nor repeated across pages).
   */
  async findClosed(limit: number, before?: Date, beforeId?: string): Promise<IImageModerationIncidentDocument[]> {
    const cursor = !before
      ? {}
      : beforeId
        ? {
            $or: [
              { createdAt: { $lt: before } },
              { createdAt: before, _id: { $lt: new mongoose.Types.ObjectId(beforeId) } },
            ],
          }
        : { createdAt: { $lt: before } };
    return this.model
      .find({ reviewStatus: { $in: CLOSED_REVIEW_STATUSES }, ...cursor })
      .sort({ createdAt: -1, _id: -1 })
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
   * Also overrides a 'false_positive' or 'no_action' verdict: the tip already exists at NCMEC, so
   * the record must say so, and previousReviewStatus keeps the earlier verdict visible. Never acts on
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
    // Each write is atomic on its own filter; a row can only match one of them.
    for (const previousReviewStatus of INCIDENT_OVERRIDABLE_REVIEW_STATUSES) {
      const overridden = await this.model.findOneAndUpdate(
        { _id: id, reviewStatus: previousReviewStatus },
        { $set: { ...reported, previousReviewStatus } },
        { new: true }
      );
      if (overridden) return overridden;
    }
    return null;
  }

  /**
   * Close an unreviewed incident as correctly blocked with nothing to report. Only from
   * absent/pending_review, so it never overwrites another verdict or an in-flight submission.
   * Returns null when the incident is not unreviewed (or not found).
   */
  async markNoAction(id: string, actorId: string): Promise<IImageModerationIncidentDocument | null> {
    return this.model.findOneAndUpdate(
      { _id: id, reviewStatus: { $in: UNREVIEWED_REVIEW_STATUSES } },
      { $set: { reviewStatus: 'no_action', noActionBy: actorId, noActionAt: new Date() } },
      { new: true }
    );
  }

  /**
   * Transition an incident to a terminal reviewStatus. `ncmecReportId` and the acting admin
   * (`reportedBy`, with `reportedAt`) are set when `status === 'reported'`; for 'false_positive'
   * the acting admin and time go to `falsePositiveBy`/`falsePositiveAt`. Returns null if the
   * transition is disallowed:
   * - always blocked when already 'reported' (idempotency) or 'no_action' (a closing verdict is
   *   never replaced by this method; recordManualReport is the override path)
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
    const excluded =
      status === 'false_positive' ? ['reported', 'confirmed_csam', 'no_action'] : ['reported', 'no_action'];
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
