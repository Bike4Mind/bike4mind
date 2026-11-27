import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const RESOLVED_TTL_SECONDS = 90 * 24 * 60 * 60;
const DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * One health alert for a connected app (or `platform`). `open` exists only while the alert is open,
 * so the partial unique index allows exactly one open alert per scope and rule and keeps resolved
 * history.
 */
export interface ISideAppAlertStateDocument extends IMongoDocument {
  scope: string;
  rule: string;
  open?: true;
  openedAt: Date;
  lastNotifiedAt?: Date;
  resolvedAt?: Date;
}

const SideAppAlertStateSchema = new mongoose.Schema<ISideAppAlertStateDocument>(
  {
    scope: { type: String, required: true },
    rule: { type: String, required: true },
    open: { type: Boolean },
    openedAt: { type: Date, required: true },
    lastNotifiedAt: { type: Date },
    resolvedAt: { type: Date },
  },
  { versionKey: false }
);

// Built by the ensure migration for this collection.
SideAppAlertStateSchema.index(
  { scope: 1, rule: 1 },
  { unique: true, name: 'side_app_alert_open', partialFilterExpression: { open: true } }
);
SideAppAlertStateSchema.index({ resolvedAt: 1 }, { expireAfterSeconds: RESOLVED_TTL_SECONDS });

export const SideAppAlertState: Model<ISideAppAlertStateDocument> =
  mongoose.models.SideAppAlertState ||
  mongoose.model<ISideAppAlertStateDocument>('SideAppAlertState', SideAppAlertStateSchema);

export interface OpenAlertRef {
  id: string;
  scope: string;
  rule: string;
  openedAt: Date;
  lastNotifiedAt?: Date;
}

export class SideAppAlertStateRepository extends BaseRepository<ISideAppAlertStateDocument> {
  constructor(model: Model<ISideAppAlertStateDocument>) {
    super(model);
  }

  /**
   * Insert an open alert, stamped as notified by the caller unless `notified` is false (held back,
   * to be announced later). A duplicate-key error means another run already holds the open alert,
   * so only the run that gets `opened` may send.
   */
  async open(
    scope: string,
    rule: string,
    now: Date,
    notified = true
  ): Promise<{ outcome: 'opened'; id: string } | { outcome: 'exists' }> {
    try {
      const doc = await this.model.create({
        scope,
        rule,
        open: true,
        openedAt: now,
        ...(notified ? { lastNotifiedAt: now } : {}),
      });
      return { outcome: 'opened', id: String(doc._id) };
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE) return { outcome: 'exists' };
      throw error;
    }
  }

  async listOpen(): Promise<OpenAlertRef[]> {
    const docs = await this.model.find({ open: true }).lean();
    return docs.map(doc => ({
      id: String(doc._id),
      scope: doc.scope,
      rule: doc.rule,
      openedAt: doc.openedAt,
      lastNotifiedAt: doc.lastNotifiedAt,
    }));
  }

  /**
   * Take the right to send a notification for an open alert. Succeeds for one caller only: the
   * update matches the `lastNotifiedAt` that caller read.
   */
  async claimNotification(id: string, seen: Date | undefined, now: Date): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, open: true, lastNotifiedAt: seen ?? { $exists: false } },
      { $set: { lastNotifiedAt: now } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  }

  /** Give a claim back after the post failed, so the next run sends it. */
  async releaseClaim(id: string, claimedAt: Date, previous: Date | undefined): Promise<void> {
    await this.model.updateOne(
      { _id: id, open: true, lastNotifiedAt: claimedAt },
      previous ? { $set: { lastNotifiedAt: previous } } : { $unset: { lastNotifiedAt: 1 } },
      { runValidators: true }
    );
  }

  /** Close an open alert. Returns whether this call closed it. */
  async resolve(id: string, now: Date): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, open: true },
      { $unset: { open: 1 }, $set: { resolvedAt: now } },
      { runValidators: true }
    );
    return result.modifiedCount === 1;
  }
}

export const sideAppAlertStateRepository = new SideAppAlertStateRepository(SideAppAlertState);
