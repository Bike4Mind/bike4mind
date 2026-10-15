import mongoose, { Schema, model, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * IntegrationRequest - one user's vote for a roadmap integration on the Integrations page
 * (apps/client/pages/api/integrations/requests.ts). `integrationId` is a planned id from the
 * integrations catalog in @bike4mind/common; the route validates it, the model stores any string.
 *
 * One row per (userId, integrationId), enforced by the unique compound index; writers upsert,
 * so a repeated request is a no-op. Withdrawing deletes the row.
 */
export interface IIntegrationRequestDocument extends Document {
  id: string;
  userId: string;
  organizationId?: string | null;
  integrationId: string;
  createdAt: Date;
  updatedAt: Date;
}

const IntegrationRequestSchema = new Schema(
  {
    userId: { type: String, required: true },
    organizationId: { type: String, default: null },
    integrationId: { type: String, required: true, maxlength: 64 },
  },
  {
    timestamps: true,
    collection: 'integration_requests',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

IntegrationRequestSchema.index({ userId: 1, integrationId: 1 }, { unique: true });
IntegrationRequestSchema.index({ integrationId: 1 });

export const IntegrationRequest =
  (mongoose.models.IntegrationRequest as mongoose.Model<IIntegrationRequestDocument>) ||
  model<IIntegrationRequestDocument>('IntegrationRequest', IntegrationRequestSchema);

export class IntegrationRequestRepository extends BaseRepository<IIntegrationRequestDocument> {
  constructor(m: Model<IIntegrationRequestDocument>) {
    super(m);
  }

  /** Idempotent: upsert, so a second request from the same user changes nothing. */
  async request(userId: string, integrationId: string, organizationId?: string | null): Promise<void> {
    try {
      await this.model.updateOne(
        { userId, integrationId },
        { $setOnInsert: { userId, integrationId, organizationId: organizationId ?? null } },
        { upsert: true }
      );
    } catch (error) {
      // A concurrent upsert inserted the same row first: already requested, which is success.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  async withdraw(userId: string, integrationId: string): Promise<void> {
    await this.model.deleteOne({ userId, integrationId });
  }

  /** Request count per integration id, across all users. */
  async countsByIntegration(): Promise<Record<string, number>> {
    const rows = await this.model.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$integrationId', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
  }

  async requestedBy(userId: string): Promise<string[]> {
    const rows = await this.model.find({ userId }).select('integrationId').lean<Array<{ integrationId: string }>>();
    return rows.map(r => r.integrationId);
  }
}

export const integrationRequestRepository = new IntegrationRequestRepository(IntegrationRequest);
