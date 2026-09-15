import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IMongoDocument } from '@bike4mind/common';
import type { SocialPlatform } from './OverwatchSocialConnectionModel';

/**
 * Cached company social posts surfaced in the Overwatch Amplify feed.
 *
 * Populated by the Amplify ingestion cron (Bluesky via public AppView; Facebook
 * via per-product system-user token). The feed reads from this cache rather than
 * fan-out fetching on every request, mirroring the gaCache / rollup pattern. A
 * TTL index prunes posts past the retention window automatically.
 */

export type AmplifyMediaType = 'image' | 'link_card' | 'generative_card' | 'video';

export interface IAmplifyMedia {
  type: AmplifyMediaType;
  title?: string;
  url?: string;
}

export interface IAmplifyPostStats {
  views?: number;
  likes?: number;
  reposts?: number;
}

export interface IOverwatchAmplifyPostDocument extends IMongoDocument {
  productId: string;
  productName: string;
  platform: SocialPlatform; // ingestion source: 'bluesky' | 'facebook'
  /** Platform-native post id - unique per platform. */
  postId: string;
  sourceHandle: string;
  publishedAt: Date;
  text: string;
  media?: IAmplifyMedia;
  /** External link carried by the post - used to pre-fill X/Facebook share intents. */
  primaryLink?: string;
  stats: IAmplifyPostStats;
  /** Canonical web URL of the original post (e.g. https://bsky.app/profile/<h>/post/<rkey>). */
  permalink: string;
  ingestedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MediaSchema = new Schema<IAmplifyMedia>(
  {
    type: { type: String, enum: ['image', 'link_card', 'generative_card', 'video'], required: true },
    title: { type: String },
    url: { type: String },
  },
  { _id: false }
);

const RETENTION_SECONDS = 90 * 24 * 60 * 60; // 90 days

const OverwatchAmplifyPostSchema = new Schema<IOverwatchAmplifyPostDocument>(
  {
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    platform: { type: String, required: true },
    postId: { type: String, required: true },
    sourceHandle: { type: String, required: true },
    publishedAt: { type: Date, required: true },
    text: { type: String, default: '' },
    media: { type: MediaSchema },
    primaryLink: { type: String },
    stats: { type: Schema.Types.Mixed, default: {} },
    permalink: { type: String, required: true },
    ingestedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One cached row per platform post - makes ingestion upserts idempotent across cron runs.
OverwatchAmplifyPostSchema.index(
  { platform: 1, postId: 1 },
  { unique: true, name: 'overwatch_amplify_post_platform_postid' }
);
// Feed query: newest-first. TTL prunes posts past the retention window (deletes by publishedAt age).
OverwatchAmplifyPostSchema.index(
  { publishedAt: -1 },
  { name: 'overwatch_amplify_post_published', expireAfterSeconds: RETENTION_SECONDS }
);

export interface IOverwatchAmplifyPostModel extends Model<IOverwatchAmplifyPostDocument & IMongoDocument> {}

export const OverwatchAmplifyPost: IOverwatchAmplifyPostModel =
  mongoose.models.OverwatchAmplifyPost ??
  model<IOverwatchAmplifyPostDocument>('OverwatchAmplifyPost', OverwatchAmplifyPostSchema);

class OverwatchAmplifyPostRepository extends BaseRepository<IOverwatchAmplifyPostDocument & IMongoDocument> {
  constructor() {
    super(OverwatchAmplifyPost);
  }

  /** Idempotent upsert keyed on (platform, postId) - re-running the cron refreshes stats without duplicating. */
  async upsertByPostId(platform: string, postId: string, data: Partial<IOverwatchAmplifyPostDocument>): Promise<void> {
    await this.model.updateOne(
      { platform, postId },
      { $set: { ...data, platform, postId, ingestedAt: new Date() } },
      { upsert: true }
    );
  }

  /** Feed read: newest-first, capped. Optionally scoped to one product. */
  async listForFeed(
    opts: { productId?: string; limit?: number } = {}
  ): Promise<(IOverwatchAmplifyPostDocument & IMongoDocument)[]> {
    const filter = opts.productId ? { productId: opts.productId } : {};
    const results = await this.model
      .find(filter)
      .sort({ publishedAt: -1 })
      .limit(opts.limit ?? 100);
    return results.map(doc => doc.toJSON());
  }
}

export const overwatchAmplifyPostRepository = new OverwatchAmplifyPostRepository();
