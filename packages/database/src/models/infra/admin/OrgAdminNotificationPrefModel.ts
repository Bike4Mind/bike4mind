import mongoose, { Model, Schema } from 'mongoose';
import type {
  IOrgAdminNotificationPrefDocument,
  IOrgAdminNotificationPrefRepository,
  OrgAlertKindPrefs,
} from '@bike4mind/common';
import { ORG_ALERT_KINDS } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'OrgAdminNotificationPref';

interface IOrgAdminNotificationPrefModel extends Model<IOrgAdminNotificationPrefDocument> {}

// No defaults on the kind flags: an absent flag means "use the role default" (resolveOrgAlertOptIn).
const kindsDefinition = Object.fromEntries(ORG_ALERT_KINDS.map(kind => [kind, { type: Boolean }]));

const OrgAdminNotificationPrefSchema = new Schema<IOrgAdminNotificationPrefDocument>(
  {
    organizationId: { type: String, required: true },
    userId: { type: String, required: true },
    kinds: { type: new Schema(kindsDefinition, { _id: false }), default: () => ({}) },
  },
  { timestamps: true, versionKey: false }
);

OrgAdminNotificationPrefSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
OrgAdminNotificationPrefSchema.index({ userId: 1 });

export const OrgAdminNotificationPrefModel: IOrgAdminNotificationPrefModel =
  (mongoose.models[ModelName] as IOrgAdminNotificationPrefModel) ||
  mongoose.model<IOrgAdminNotificationPrefDocument, IOrgAdminNotificationPrefModel>(
    ModelName,
    OrgAdminNotificationPrefSchema
  );

class OrgAdminNotificationPrefRepository
  extends BaseRepository<IOrgAdminNotificationPrefDocument>
  implements IOrgAdminNotificationPrefRepository
{
  constructor(private prefModel: mongoose.Model<IOrgAdminNotificationPrefDocument>) {
    super(prefModel);
  }

  async getForOrg(organizationId: string): Promise<IOrgAdminNotificationPrefDocument[]> {
    return this.prefModel.find({ organizationId }).lean<IOrgAdminNotificationPrefDocument[]>();
  }

  async getForUser(organizationId: string, userId: string): Promise<IOrgAdminNotificationPrefDocument | null> {
    return this.prefModel.findOne({ organizationId, userId }).lean<IOrgAdminNotificationPrefDocument>();
  }

  async upsertForUser(
    organizationId: string,
    userId: string,
    kinds: OrgAlertKindPrefs
  ): Promise<IOrgAdminNotificationPrefDocument | null> {
    const set: Record<string, boolean> = {};
    for (const kind of ORG_ALERT_KINDS) {
      const value = kinds[kind];
      if (typeof value === 'boolean') set[`kinds.${kind}`] = value;
    }
    return this.prefModel
      .findOneAndUpdate(
        { organizationId, userId },
        { $set: set, $setOnInsert: { organizationId, userId } },
        { upsert: true, new: true }
      )
      .lean<IOrgAdminNotificationPrefDocument>();
  }
}

export const orgAdminNotificationPrefRepository = new OrgAdminNotificationPrefRepository(OrgAdminNotificationPrefModel);
