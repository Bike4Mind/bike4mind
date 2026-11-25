import mongoose, { Model, Schema } from 'mongoose';
import type {
  IOrgAdminNotificationPrefDocument,
  IOrgAdminNotificationPrefRepository,
  OrgAlertKindPrefs,
} from '@bike4mind/common';
import { ORG_ALERT_KINDS } from '@bike4mind/common';
import BaseRepository, { withTransaction } from '@bike4mind/db-core';
import { NotFoundError } from '@bike4mind/utils';
import { lockLiveOrgAlertUser, orgAlertOrganizationIdSchema } from '../../../utils/orgAlertUsers';

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
    const canonicalId = orgAlertOrganizationIdSchema.parse(organizationId);
    const rows = await this.prefModel
      .find({ organizationId: new RegExp(`^${canonicalId}$`, 'i') })
      .sort({ organizationId: 1, _id: 1 })
      .lean<IOrgAdminNotificationPrefDocument[]>();
    const byUser = new Map<string, IOrgAdminNotificationPrefDocument>();
    for (const row of rows) {
      if (!byUser.has(row.userId) || row.organizationId === canonicalId) byUser.set(row.userId, row);
    }
    return [...byUser.values()];
  }

  async getForUser(organizationId: string, userId: string): Promise<IOrgAdminNotificationPrefDocument | null> {
    const canonicalId = orgAlertOrganizationIdSchema.parse(organizationId);
    const canonical = await this.prefModel
      .findOne({ organizationId: canonicalId, userId })
      .lean<IOrgAdminNotificationPrefDocument>();
    if (canonical) return canonical;
    return this.prefModel
      .findOne({ organizationId: new RegExp(`^${canonicalId}$`, 'i'), userId })
      .sort({ organizationId: 1, _id: 1 })
      .lean<IOrgAdminNotificationPrefDocument>();
  }

  async upsertForUser(
    organizationId: string,
    userId: string,
    kinds: OrgAlertKindPrefs
  ): Promise<IOrgAdminNotificationPrefDocument | null> {
    const canonicalId = orgAlertOrganizationIdSchema.parse(organizationId);
    await this.prefModel.init();
    return withTransaction(async session => {
      const canonicalUserId = await lockLiveOrgAlertUser(userId, session);
      if (!canonicalUserId) throw new NotFoundError('Account unavailable');
      const existing = await this.getForUser(canonicalId, canonicalUserId);
      const merged: OrgAlertKindPrefs = {};
      for (const kind of ORG_ALERT_KINDS) {
        const value = kinds[kind] ?? existing?.kinds?.[kind];
        if (typeof value === 'boolean') merged[kind] = value;
      }
      return this.prefModel
        .findOneAndUpdate(
          { organizationId: canonicalId, userId: canonicalUserId },
          { $set: { kinds: merged }, $setOnInsert: { organizationId: canonicalId, userId: canonicalUserId } },
          { upsert: true, new: true, session }
        )
        .lean<IOrgAdminNotificationPrefDocument>();
    });
  }
}

export const orgAdminNotificationPrefRepository = new OrgAdminNotificationPrefRepository(OrgAdminNotificationPrefModel);
