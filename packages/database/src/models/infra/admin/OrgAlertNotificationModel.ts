import mongoose, { Model, Schema } from 'mongoose';
import type {
  ClaimOrgAlertInput,
  IOrgAlertNotificationDocument,
  IOrgAlertNotificationRepository,
} from '@bike4mind/common';
import { ORG_ALERT_KINDS, ORG_ALERT_NOTIFICATION_RETENTION_DAYS } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'OrgAlertNotification';

interface IOrgAlertNotificationModel extends Model<IOrgAlertNotificationDocument> {}

const OrgAlertNotificationSchema = new Schema<IOrgAlertNotificationDocument>(
  {
    organizationId: { type: String, required: true },
    kind: { type: String, enum: ORG_ALERT_KINDS, required: true },
    scope: { type: String, required: true },
    periodKey: { type: String, required: true },
    subjectUserId: { type: String },
    sentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

// Uniqueness is correctness here: claim() treats this index rejecting a second writer as "lost".
OrgAlertNotificationSchema.index({ organizationId: 1, kind: 1, scope: 1, periodKey: 1 }, { unique: true });
OrgAlertNotificationSchema.index({ subjectUserId: 1 }, { sparse: true });
OrgAlertNotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OrgAlertNotificationModel: IOrgAlertNotificationModel =
  (mongoose.models[ModelName] as IOrgAlertNotificationModel) ||
  mongoose.model<IOrgAlertNotificationDocument, IOrgAlertNotificationModel>(ModelName, OrgAlertNotificationSchema);

class OrgAlertNotificationRepository
  extends BaseRepository<IOrgAlertNotificationDocument>
  implements IOrgAlertNotificationRepository
{
  constructor(private notificationModel: mongoose.Model<IOrgAlertNotificationDocument>) {
    super(notificationModel);
  }

  async claim(input: ClaimOrgAlertInput): Promise<{ claimed: boolean; id?: string }> {
    const { organizationId, kind, scope, periodKey } = input;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ORG_ALERT_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    try {
      // lastErrorObject.upserted is set only when this call performed the insert.
      const result = await this.notificationModel.findOneAndUpdate(
        { organizationId, kind, scope, periodKey },
        {
          $setOnInsert: {
            organizationId,
            kind,
            scope,
            periodKey,
            subjectUserId: input.subjectUserId ?? undefined,
            sentAt: now,
            expiresAt,
          },
        },
        { upsert: true, includeResultMetadata: true }
      );
      const upsertedId = result.lastErrorObject?.upserted;
      if (!upsertedId) return { claimed: false };
      return { claimed: true, id: String(upsertedId) };
    } catch (err) {
      // E11000: a concurrent claimer inserted between our filter match and our insert.
      if ((err as { code?: number }).code === 11000) return { claimed: false };
      throw err;
    }
  }

  async release(id: string): Promise<void> {
    await this.notificationModel.deleteOne({ _id: id });
  }
}

export const orgAlertNotificationRepository = new OrgAlertNotificationRepository(OrgAlertNotificationModel);
