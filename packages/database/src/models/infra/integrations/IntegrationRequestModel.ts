import mongoose, { Schema, model, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/**
 * IntegrationRequest - one user's vote for a roadmap integration on the Integrations page
 * (apps/client/pages/api/integrations/requests.ts). `integrationId` is a planned id from the
 * integrations catalog in @bike4mind/common; the route validates it, the model stores any string.
 *
 * One row per (userId, integrationId), enforced by the unique compound index; writers upsert,
 * so a repeated request is a no-op. Withdrawing deletes the row. Who requested what is
 * admin-only (apps/client/pages/api/admin/integrations/demand/); the user route returns counts.
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
// Serves the admin requester list (requestersFor) in its sort order, and any integrationId-only query.
IntegrationRequestSchema.index({ integrationId: 1, createdAt: -1, _id: -1 });

export const IntegrationRequest =
  (mongoose.models.IntegrationRequest as mongoose.Model<IIntegrationRequestDocument>) ||
  model<IIntegrationRequestDocument>('IntegrationRequest', IntegrationRequestSchema);

export interface IntegrationDemandSummaryRow {
  integrationId: string;
  total: number;
  /** Distinct organizations among the requesters; requests filed without one are not counted here. */
  organizations: number;
  firstRequestedAt: Date;
  latestRequestedAt: Date;
}

export interface IntegrationRequesterRow {
  id: string;
  userId: string;
  organizationId: string | null;
  createdAt: Date;
}

/** Position in a requester list ordered (createdAt, _id) descending. */
export interface IntegrationRequesterKeyset {
  createdAt: Date;
  id: string;
}

const REQUESTER_PAGE_SORT = { createdAt: -1, _id: -1 } as const;

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

  /**
   * Request count for each of `integrationIds`, across all users. Ids with no rows are absent.
   * The $match keeps the scan to the ids the caller will show, so rows for ids that have left the
   * roadmap are never read, and lets the (integrationId, ...) index serve the grouping.
   */
  async countsByIntegration(integrationIds: readonly string[]): Promise<Record<string, number>> {
    const rows = await this.model.aggregate<{ _id: string; count: number }>([
      { $match: { integrationId: { $in: [...integrationIds] } } },
      { $group: { _id: '$integrationId', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
  }

  /**
   * Admin demand view: per integration id, most requested first. Covers every id with a row,
   * including ids that have since left the roadmap. Two $group stages count distinct
   * organizations without building per-id arrays; no $facet or $lookup, so it runs unchanged on
   * DocumentDB (b4m-core/db-core/src/utils/documentdb-compat.ts).
   */
  async demandSummary(): Promise<IntegrationDemandSummaryRow[]> {
    const rows = await this.model.aggregate<{
      _id: string;
      total: number;
      organizations: number;
      firstRequestedAt: Date;
      latestRequestedAt: Date;
    }>([
      {
        $group: {
          // $ifNull folds a missing organizationId into null, so both count as "no organization".
          _id: { integrationId: '$integrationId', organizationId: { $ifNull: ['$organizationId', null] } },
          total: { $sum: 1 },
          first: { $min: '$createdAt' },
          latest: { $max: '$createdAt' },
        },
      },
      {
        $group: {
          _id: '$_id.integrationId',
          total: { $sum: '$total' },
          organizations: { $sum: { $cond: [{ $eq: ['$_id.organizationId', null] }, 0, 1] } },
          firstRequestedAt: { $min: '$first' },
          latestRequestedAt: { $max: '$latest' },
        },
      },
      { $sort: { total: -1, _id: 1 } },
    ]);
    return rows.map(({ _id, ...row }) => ({ integrationId: _id, ...row }));
  }

  /** One page of an integration's requesters, newest first; `after` resumes past a previous page's last row. */
  async requestersFor(
    integrationId: string,
    { limit, after }: { limit: number; after?: IntegrationRequesterKeyset }
  ): Promise<{ items: IntegrationRequesterRow[]; hasMore: boolean }> {
    const filter = after
      ? {
          integrationId,
          $or: [
            { createdAt: { $lt: after.createdAt } },
            { createdAt: after.createdAt, _id: { $lt: new mongoose.Types.ObjectId(after.id) } },
          ],
        }
      : { integrationId };
    const rows = await this.model
      .find(filter)
      .select('userId organizationId createdAt')
      .sort(REQUESTER_PAGE_SORT)
      .limit(limit + 1)
      .lean<Array<{ _id: mongoose.Types.ObjectId; userId: string; organizationId?: string | null; createdAt: Date }>>();
    return {
      items: rows.slice(0, limit).map(row => ({
        id: String(row._id),
        userId: row.userId,
        organizationId: row.organizationId ?? null,
        createdAt: row.createdAt,
      })),
      hasMore: rows.length > limit,
    };
  }

  async requestedBy(userId: string): Promise<string[]> {
    const rows = await this.model.find({ userId }).select('integrationId').lean<Array<{ integrationId: string }>>();
    return rows.map(r => r.integrationId);
  }

  /** Account deletion: drop every request the user filed (apps/client/server/services/purgeDeletedUserData.ts). */
  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.model.deleteMany({ userId });
    return result.deletedCount ?? 0;
  }

  /**
   * Organization deletion: the requests are the members' own and survive the org; only the
   * association is dropped (apps/client/pages/api/organizations/[id]/index.ts).
   */
  async clearOrganization(organizationId: string): Promise<number> {
    const result = await this.model.updateMany({ organizationId }, { $set: { organizationId: null } });
    return result.modifiedCount;
  }
}

export const integrationRequestRepository = new IntegrationRequestRepository(IntegrationRequest);
