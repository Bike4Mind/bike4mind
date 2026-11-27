import mongoose, { Model, Schema, model } from 'mongoose';
import type { OverwatchLane } from '@bike4mind/common';

const ModelName = 'AnalyticsHop';

/**
 * A verified hop: one click that left a source product for this app, minted by the source's server
 * with its own ingest key and redeemed here at most once (apps/client server/analytics/hops.ts).
 *
 * The source product is the key's product, never a value the source sends, so no link or parameter
 * can name another product as the source. `redeemedAt` is null until the destination redeems the
 * hop's token; the redeem is a conditional update on that null, which is what makes it single use.
 *
 * `expiresAt` is the record's retention, swept by a TTL index. A record without it is kept, which
 * is how a hop a signup was bound to stays: a payment may later cite it.
 */
export interface IAnalyticsHopDoc {
  _id: string;
  /** Random, 32 hex characters. The first segment of the hop's token. */
  hopId: string;
  /** The Overwatch product whose ingest key minted the hop. */
  srcProductId: string;
  /** The product the hop goes to; only a destination that can redeem is accepted at mint. */
  dest: string;
  /** The destination path the source asked to land on. */
  path?: string;
  /** The source's own session id, sent only when the source may link it (its consent). */
  srcSessionId?: string;
  /** The source's hash of its visitor, sent only with consent. Never a raw identifier. */
  srcVisitorHash?: string;
  /** The analytics lane the source declared for the click (a test persona's run). */
  lane?: OverwatchLane;
  createdAt: Date;
  redeemedAt: Date | null;
  /** The destination visit the hop was redeemed in. Set only when the visitor consented. */
  redeemedSessionId?: string;
  /** When a signup in that visit was bound to the hop (user.acquisition.verifiedTouch). Once. */
  boundAt?: Date;
  expiresAt?: Date;
}

export type AnalyticsHopInput = Omit<IAnalyticsHopDoc, '_id' | 'redeemedAt' | 'redeemedSessionId' | 'boundAt'>;

type IAnalyticsHopModel = Model<IAnalyticsHopDoc>;

const AnalyticsHopSchema = new Schema<IAnalyticsHopDoc>(
  {
    hopId: { type: String, required: true },
    srcProductId: { type: String, required: true },
    dest: { type: String, required: true },
    path: { type: String, required: false },
    srcSessionId: { type: String, required: false },
    srcVisitorHash: { type: String, required: false },
    lane: { type: String, required: false },
    createdAt: { type: Date, required: true },
    redeemedAt: { type: Date, default: null },
    redeemedSessionId: { type: String, required: false },
    boundAt: { type: Date, required: false },
    expiresAt: { type: Date, required: false },
  },
  { collection: 'analytics_hops' }
);

AnalyticsHopSchema.index({ hopId: 1 }, { unique: true });
// Retention sweep. A document without expiresAt never expires, which is how a hop stays kept.
AnalyticsHopSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AnalyticsHop: IAnalyticsHopModel =
  (mongoose.models[ModelName] as IAnalyticsHopModel) ||
  model<IAnalyticsHopDoc, IAnalyticsHopModel>(ModelName, AnalyticsHopSchema);

export const analyticsHopRepository = {
  async create(hop: AnalyticsHopInput): Promise<IAnalyticsHopDoc> {
    const doc = await AnalyticsHop.create({ ...hop, redeemedAt: null });
    return doc.toObject() as IAnalyticsHopDoc;
  },

  async findByHopId(hopId: string): Promise<IAnalyticsHopDoc | null> {
    return AnalyticsHop.findOne({ hopId }).lean<IAnalyticsHopDoc>().exec();
  },

  /**
   * Redeem a hop, once. One conditional update: only a hop for this destination, minted no earlier
   * than `mintedSince`, and not yet redeemed matches, so two concurrent redeems of one token cannot
   * both succeed. Null when nothing matched: unknown, already redeemed, another destination's, or
   * too old. `sessionId` is the visit it was redeemed in, omitted when that may not be linked.
   */
  async redeem(opts: {
    hopId: string;
    dest: string;
    now: Date;
    mintedSince: Date;
    sessionId?: string;
  }): Promise<IAnalyticsHopDoc | null> {
    return AnalyticsHop.findOneAndUpdate(
      { hopId: opts.hopId, dest: opts.dest, redeemedAt: null, createdAt: { $gte: opts.mintedSince } },
      { $set: { redeemedAt: opts.now, ...(opts.sessionId !== undefined && { redeemedSessionId: opts.sessionId }) } },
      { new: true }
    )
      .lean<IAnalyticsHopDoc>()
      .exec();
  },

  /**
   * Bind a redeemed hop to the signup that followed it, once, and keep it: a bound hop is the
   * evidence a payment may later cite, so its retention (`expiresAt`) is removed. Only a hop for this
   * destination, redeemed in visit `sessionId` no earlier than `redeemedSince`, and never bound
   * matches, in one conditional update, so two signups cannot both take one hop. Null otherwise.
   */
  async bindToSignup(opts: {
    hopId: string;
    dest: string;
    sessionId: string;
    now: Date;
    redeemedSince: Date;
  }): Promise<IAnalyticsHopDoc | null> {
    return AnalyticsHop.findOneAndUpdate(
      {
        hopId: opts.hopId,
        dest: opts.dest,
        redeemedSessionId: opts.sessionId,
        redeemedAt: { $gte: opts.redeemedSince },
        boundAt: null,
      },
      { $set: { boundAt: opts.now }, $unset: { expiresAt: 1 } },
      { new: true }
    )
      .lean<IAnalyticsHopDoc>()
      .exec();
  },
};
