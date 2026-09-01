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
 * A community or site where the team could organically post about this product -
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
   * Where the community's self-promotion rules go - "1 in 10 posts", "mods approve links
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
    // default [] covers new inserts; lean reads of older documents are normalized in the
    // repository instead, since schema defaults never run on them.
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

/**
 * Schema defaults do not apply to `.lean()` reads - those return the raw driver document,
 * so a product stored before `postingChannels` existed comes back without the key. Every
 * read goes through here so the non-optional field on IOverwatchProductDoc stays true and
 * callers can iterate unconditionally without a migration.
 *
 * Mutates in place, which is safe: lean results are fresh POJOs owned by the caller.
 */
function withPostingChannels(doc: IOverwatchProductDoc): IOverwatchProductDoc {
  if (!doc.postingChannels) doc.postingChannels = [];
  return doc;
}

export const overwatchProductRepository = {
  async getActiveProducts(organizationId?: string): Promise<IOverwatchProductDoc[]> {
    const filter: Record<string, unknown> = { status: 'active' };
    if (organizationId) filter.organizationId = organizationId;
    const products = await OverwatchProduct.find(filter).sort({ name: 1 }).lean();
    return products.map(withPostingChannels);
  },

  async getAllProducts(): Promise<IOverwatchProductDoc[]> {
    const products = await OverwatchProduct.find().sort({ name: 1 }).lean();
    return products.map(withPostingChannels);
  },

  async getByProductId(productId: string): Promise<IOverwatchProductDoc | null> {
    const product = await OverwatchProduct.findOne({ productId }).lean();
    return product ? withPostingChannels(product) : null;
  },

  /**
   * Five fields that are required on the document are optional here: `postingChannels`,
   * `socialLinks`, `customEvents`, `campaignLinks` and `status`.
   *
   * This method issues `findOneAndUpdate(..., { $set: data }, { upsert: true })`, so the
   * two states a caller can express are not "a value" and "empty" - they are "a value"
   * and "absent". A key present as `[]` or `'active'` overwrites whatever is stored. A key
   * absent from `data` is never mentioned by `$set`, so the stored value survives.
   *
   * Requiring these fields forces every caller to supply a value for every field on every
   * write, including fields it knows nothing about. A caller making a partial update has
   * no correct value to send: it must either invent one, which silently destroys the
   * stored data and still returns success, or fail to compile. Optional is what lets
   * omission mean "leave this alone" - the only safe meaning for a field the caller does
   * not own.
   *
   * Safe on insert: the schema defaults all five (`[]` for the four array fields,
   * `'active'` for `status`), and those defaults apply on the upsert-insert. Reads
   * normalize `postingChannels` for documents written before that field existed, since
   * schema defaults never run on them - see withPostingChannels.
   *
   * Adding any of these back as required would break every existing caller at compile
   * time - the same drift that left downstream callers uncompilable when core last made
   * an established field required.
   */
  async upsertProduct(
    data: Omit<
      IOverwatchProductDoc,
      | '_id'
      | 'createdAt'
      | 'updatedAt'
      | 'postingChannels'
      | 'socialLinks'
      | 'customEvents'
      | 'campaignLinks'
      | 'status'
    > & {
      postingChannels?: IPostingChannel[];
      socialLinks?: ISocialLink[];
      customEvents?: ICustomEvent[];
      campaignLinks?: ICampaignLink[];
      // Indexed off the document type rather than restating the union, so a new status
      // value cannot be accepted here while being unrepresentable on the document.
      status?: IOverwatchProductDoc['status'];
    }
  ): Promise<IOverwatchProductDoc> {
    const result = await OverwatchProduct.findOneAndUpdate(
      { productId: data.productId },
      { $set: data },
      { upsert: true, new: true, lean: true }
    );
    return withPostingChannels(result as IOverwatchProductDoc);
  },

  async deleteByProductId(productId: string): Promise<boolean> {
    const result = await OverwatchProduct.deleteOne({ productId });
    return result.deletedCount > 0;
  },
};
