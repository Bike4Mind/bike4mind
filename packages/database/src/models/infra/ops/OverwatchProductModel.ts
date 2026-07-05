import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'OverwatchProduct';

// Interfaces

export interface ISocialLink {
  platform: string;
  url: string;
  handle?: string;
}

export interface ICustomEvent {
  name: string;
  label: string;
}

export interface ICampaignLink {
  label: string;
  url: string;
}

export interface IOverwatchProductDoc {
  _id: string;
  /** Unique slug identifier: 'vibeswire', 'bike4mind', etc. */
  productId: string;
  /** Display name */
  name: string;
  /** GA4 property ID (e.g., 'properties/123456789') */
  gaPropertyId?: string;
  /** Links to social media accounts for this product */
  socialLinks: ISocialLink[];
  /** GA4 custom events to track per product */
  customEvents: ICustomEvent[];
  /** Tracked campaign URLs - shown in Traffic tab regardless of GA4 data */
  campaignLinks: ICampaignLink[];
  /** Org-scoped for future multi-tenant */
  organizationId?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

interface IOverwatchProductModel extends Model<IOverwatchProductDoc> {}

// Schema

const SocialLinkSchema = new Schema<ISocialLink>(
  {
    platform: { type: String, required: true },
    url: { type: String, required: true },
    handle: { type: String },
  },
  { _id: false }
);

const CustomEventSchema = new Schema<ICustomEvent>(
  {
    name: { type: String, required: true },
    label: { type: String, required: true },
  },
  { _id: false }
);

const CampaignLinkSchema = new Schema<ICampaignLink>(
  {
    label: { type: String, required: true },
    url: { type: String, required: true },
  },
  { _id: false }
);

const OverwatchProductSchema = new Schema<IOverwatchProductDoc>(
  {
    productId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    gaPropertyId: { type: String },
    socialLinks: { type: [SocialLinkSchema], default: [] },
    customEvents: { type: [CustomEventSchema], default: [] },
    campaignLinks: { type: [CampaignLinkSchema], default: [] },
    organizationId: { type: String },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  { timestamps: true }
);

// Performance indexes
OverwatchProductSchema.index({ organizationId: 1, status: 1 });

// Model

export const OverwatchProduct: IOverwatchProductModel =
  (mongoose.models[ModelName] as IOverwatchProductModel) ||
  model<IOverwatchProductDoc, IOverwatchProductModel>(ModelName, OverwatchProductSchema);

// Repository

export const overwatchProductRepository = {
  async getActiveProducts(organizationId?: string): Promise<IOverwatchProductDoc[]> {
    const filter: Record<string, unknown> = { status: 'active' };
    if (organizationId) filter.organizationId = organizationId;
    return OverwatchProduct.find(filter).sort({ name: 1 }).lean();
  },

  async getAllProducts(): Promise<IOverwatchProductDoc[]> {
    return OverwatchProduct.find().sort({ name: 1 }).lean();
  },

  async getByProductId(productId: string): Promise<IOverwatchProductDoc | null> {
    return OverwatchProduct.findOne({ productId }).lean();
  },

  async upsertProduct(
    data: Omit<IOverwatchProductDoc, '_id' | 'createdAt' | 'updatedAt'>
  ): Promise<IOverwatchProductDoc> {
    const result = await OverwatchProduct.findOneAndUpdate(
      { productId: data.productId },
      { $set: data },
      { upsert: true, new: true, lean: true }
    );
    return result as IOverwatchProductDoc;
  },

  async deleteByProductId(productId: string): Promise<boolean> {
    const result = await OverwatchProduct.deleteOne({ productId });
    return result.deletedCount > 0;
  },
};
