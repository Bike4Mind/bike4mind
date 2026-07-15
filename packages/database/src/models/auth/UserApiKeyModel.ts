import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import {
  ApiKeyStatus,
  ApiKeyScope,
  CreditHolderType,
  IEmbedBranding,
  IUserApiKeyDocument,
  IUserApiKeyRepository,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IUserApiKeyModel extends mongoose.Model<IUserApiKeyDocument> {}

class UserApiKeyRepository extends BaseRepository<IUserApiKeyDocument> implements IUserApiKeyRepository {
  constructor(model: IUserApiKeyModel) {
    super(model);
  }

  findByKeyPrefix(keyPrefix: string) {
    return this.model.findOne({ keyPrefix, status: ApiKeyStatus.ACTIVE }).exec();
  }

  findByUserId(userId: string) {
    return this.model.find({ userId }).sort({ createdAt: -1 }).exec();
  }

  findByUserIdAndId(userId: string, id: string) {
    return this.model.findOne({ _id: id, userId }).exec();
  }

  async updateUsage(id: string, usage: Partial<IUserApiKeyDocument['usage']>) {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          'usage.totalRequests': usage.totalRequests,
          'usage.totalTokens': usage.totalTokens,
          'usage.lastRequest': usage.lastRequest,
          'usage.requestsToday': usage.requestsToday,
          'usage.requestsThisMinute': usage.requestsThisMinute,
        },
      }
    );
  }

  async updateLastUsed(id: string) {
    await this.model.updateOne(
      { _id: id },
      {
        $set: { lastUsedAt: new Date() },
      }
    );
  }

  findActiveByKeyPrefix(keyPrefix: string) {
    return this.model
      .findOne({
        keyPrefix,
        status: ApiKeyStatus.ACTIVE,
        $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: null }],
      })
      .exec();
  }

  async deactivateAllByUserId(userId: string) {
    await this.model.updateMany(
      { userId },
      {
        $set: { status: ApiKeyStatus.DISABLED },
      }
    );
  }

  findExpiredKeys() {
    return this.model
      .find({
        status: ApiKeyStatus.ACTIVE,
        expiresAt: { $lt: new Date() },
      })
      .exec();
  }

  async countActiveByUserId(userId: string): Promise<number> {
    return this.model.countDocuments({ userId, status: ApiKeyStatus.ACTIVE });
  }

  findByProductId(productId: string) {
    return this.model.find({ productId }).sort({ createdAt: -1 }).exec();
  }

  findByOrganizationId(organizationId: string) {
    return this.model.find({ organizationId }).sort({ createdAt: -1 }).exec();
  }

  async countActiveByProductId(productId: string): Promise<number> {
    return this.model.countDocuments({
      productId,
      status: { $in: [ApiKeyStatus.ACTIVE, ApiKeyStatus.RATE_LIMITED] },
    });
  }

  async updateBaseline(id: string, baseline: IUserApiKeyDocument['metadata']['baseline']) {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          'metadata.baseline': baseline,
        },
      }
    );
  }
}

const UserApiKeySchema = new mongoose.Schema<IUserApiKeyDocument, IUserApiKeyModel>(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    keyHash: { type: String, required: true },
    keyPrefix: { type: String, required: true, unique: true },
    scopes: [{ type: String, enum: Object.values(ApiKeyScope), required: true }],
    status: { type: String, enum: Object.values(ApiKeyStatus), default: ApiKeyStatus.ACTIVE },
    expiresAt: { type: Date },
    lastUsedAt: { type: Date },
    rateLimit: {
      requestsPerMinute: { type: Number, required: true, default: 60 },
      requestsPerDay: { type: Number, required: true, default: 1000 },
    },
    usage: {
      totalRequests: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
      lastRequest: { type: Date },
      requestsToday: { type: Number, default: 0 },
      requestsThisMinute: { type: Number, default: 0 },
    },
    // Overwatch ingest: product this key is bound to (required when scopes includes OVERWATCH_INGEST_WRITE)
    productId: { type: String },
    productName: { type: String },
    // Billing target. Default User = personal key billed to `userId`. Organization
    // routes this key's AI usage to `organizationId`'s credit pool. See IUserApiKey.
    billingOwnerType: {
      type: String,
      enum: [CreditHolderType.User, CreditHolderType.Organization],
      default: CreditHolderType.User,
    },
    organizationId: { type: String },
    // Embed key (epic #41): agent this key is bound to (required when scopes includes EMBED_CHAT),
    // its https origin allow-list, and optional white-label branding. See IUserApiKey / IEmbedBranding.
    // `default: undefined` on both so a non-embed key does not materialize an empty
    // `[]`/`{}` (which would otherwise echo in the API response for every key).
    agentId: { type: String },
    allowedOrigins: { type: [String], default: undefined },
    branding: {
      type: new mongoose.Schema<IEmbedBranding>(
        {
          primaryColor: { type: String },
          logoUrl: { type: String },
          displayName: { type: String },
          hideBranding: { type: Boolean },
        },
        { _id: false }
      ),
      default: undefined,
    },
    metadata: {
      clientIP: { type: String },
      userAgent: { type: String },
      createdFrom: {
        type: String,
        enum: ['dashboard', 'cli', 'api', 'bridge', 'overwatch-admin', 'oauth-exchange'],
        required: true,
      },
      // Set on insert only; service layer must reject updates that change this field. Mongoose does not enforce immutability.
      createdByUserId: { type: String },
      // OAuth client that minted this key via the federated AI-token exchange. See IUserApiKeyMetadata.
      oauthClientId: { type: String },
      baseline: {
        avgRequestsPerHour: { type: Number },
        avgRequestsPerDay: { type: Number },
        commonIPs: [{ type: String }],
        commonEndpoints: [{ type: String }],
        avgResponseTime: { type: Number },
        peakHours: [{ type: Number }],
        lastCalculatedAt: { type: Date },
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: function (doc, ret: any) {
        // Never expose the keyHash in JSON responses
        delete ret.keyHash;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
    },
  }
);

UserApiKeySchema.index({ userId: 1, status: 1 });
UserApiKeySchema.index({ keyPrefix: 1, status: 1 });
UserApiKeySchema.index({ expiresAt: 1 });
UserApiKeySchema.index({ productId: 1, status: 1 }, { sparse: true });
UserApiKeySchema.index({ organizationId: 1, status: 1 }, { sparse: true });
UserApiKeySchema.index({ agentId: 1, status: 1 }, { sparse: true });

UserApiKeySchema.plugin(softDeletePlugin);

export const UserApiKey =
  (mongoose.models.UserApiKey as IUserApiKeyModel) ??
  mongoose.model<IUserApiKeyDocument, IUserApiKeyModel>('UserApiKey', UserApiKeySchema);

export const userApiKeyRepository = new UserApiKeyRepository(UserApiKey);
