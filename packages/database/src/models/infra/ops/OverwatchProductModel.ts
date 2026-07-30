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

/**
 * A community or site where the team could organically post about this product —
 * a subreddit, forum, Discord, newsletter, and so on.
 *
 * Distinct from `socialLinks`, which are accounts we own. These are places we do NOT
 * own and would be a guest in. Also distinct from the Reddit listener's watched-subreddit
 * list, which drives an ingest cron: nothing here is fetched, polled or published to. It
 * is reference material for a human deciding where to post.
 */
export interface IPostingChannel {
  /** Human label, e.g. 'r/selfhosted' or 'Hacker News'. */
  label: string;
  url: string;
  /** Optional grouping hint, e.g. 'reddit', 'discord', 'forum'. Free-form by design. */
  platform?: string;
  /**
   * Where the community's self-promotion rules go — "1 in 10 posts", "mods approve links
   * manually", "flair required". The most useful field here: without it the list records
   * where we *could* post but not whether we'd be welcome.
   */
  notes?: string;
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
  /** Communities where the team could organically post about this product. Reference only. */
  postingChannels: IPostingChannel[];
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

const PostingChannelSchema = new Schema<IPostingChannel>(
  {
    label: { type: String, required: true },
    url: { type: String, required: true },
    platform: { type: String },
    notes: { type: String },
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
    // default [] so every existing product reads back as an empty list rather than
    // undefined — no migration needed, and callers can iterate unconditionally.
    postingChannels: { type: [PostingChannelSchema], default: [] },
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

  /**
   * `postingChannels` is optional on the write path even though it is required on the
   * document, because the schema defaults it to `[]` so reads always have it.
   *
   * Deliberate: adding it as a required member of this parameter would break every
   * existing caller at compile time — the exact drift that left two overlay routes
   * uncompilable when core made an adapter field required. Omitting it also leaves any
   * stored value untouched, since `$set` never sees the key, so a caller that doesn't
   * know about this field cannot wipe it.
   */
  async upsertProduct(
    data: Omit<IOverwatchProductDoc, '_id' | 'createdAt' | 'updatedAt' | 'postingChannels'> & {
      postingChannels?: IPostingChannel[];
    }
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
