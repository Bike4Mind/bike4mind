import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import type { ArenaChoice, ArenaGoldRecord, ArenaRejectReason, IMongoDocument } from '@bike4mind/common';

export type ArenaVoteStatus = 'served' | 'voted';

export interface IArenaVoteDocument extends IMongoDocument {
  userId: string;
  pairId: string;
  /** The A/B display order was flipped for this rater. */
  swapped: boolean;
  status: ArenaVoteStatus;
  servedAt: Date;
  /** Canonical pair order: already un-swapped. */
  choice?: ArenaChoice;
  votedAt?: Date;
  responseMs?: number;
  isGold: boolean;
  goldCorrect: boolean | null;
  credited: boolean;
  creditsAwarded: number;
  rejectReason?: ArenaRejectReason;
}

const ArenaVoteSchema = new Schema<IArenaVoteDocument>(
  {
    userId: { type: String, required: true },
    pairId: { type: String, required: true },
    swapped: { type: Boolean, required: true },
    status: { type: String, enum: ['served', 'voted'], required: true },
    servedAt: { type: Date, required: true },
    choice: { type: String, enum: ['a', 'b', 'tie'] },
    votedAt: { type: Date },
    responseMs: { type: Number },
    isGold: { type: Boolean, required: true },
    goldCorrect: { type: Boolean, default: null },
    credited: { type: Boolean, required: true, default: false },
    creditsAwarded: { type: Number, required: true, default: 0 },
    rejectReason: { type: String },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

ArenaVoteSchema.index({ userId: 1, pairId: 1 }, { unique: true });
// At most one outstanding pair per user: serializes a user's votes so reward caps cannot race.
ArenaVoteSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'served' } });
ArenaVoteSchema.index({ userId: 1, status: 1, votedAt: -1 });
ArenaVoteSchema.index({ pairId: 1 });

export interface IArenaVoteModel extends Model<IArenaVoteDocument> {}

export const ArenaVote: IArenaVoteModel =
  mongoose.models.ArenaVote ?? model<IArenaVoteDocument>('ArenaVote', ArenaVoteSchema);

export interface ArenaRaterSummary extends ArenaGoldRecord {
  userId: string;
}

export interface ArenaVoteTotals {
  votes: number;
  credited: number;
  creditsAwarded: number;
}

export type ArenaVoteOutcome = {
  choice: ArenaChoice;
  votedAt: Date;
  responseMs: number;
  goldCorrect: boolean | null;
} & ({ credited: true; creditsAwarded: number } | { credited: false; rejectReason: ArenaRejectReason });

export interface ArenaRatedVote {
  userId: string;
  pairId: string;
  choice: ArenaChoice;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

export class ArenaVoteRepository extends BaseRepository<IArenaVoteDocument> {
  findOutstanding(userId: string): Promise<IArenaVoteDocument | null> {
    return this.findOne({ userId, status: 'served' });
  }

  findForPair(userId: string, pairId: string): Promise<IArenaVoteDocument | null> {
    return this.findOne({ userId, pairId });
  }

  async seenPairIds(userId: string): Promise<string[]> {
    return this.model.distinct('pairId', { userId });
  }

  /** Serve a pair to a user. Returns null when the user already has an outstanding pair. */
  async serve(data: {
    userId: string;
    pairId: string;
    swapped: boolean;
    isGold: boolean;
  }): Promise<IArenaVoteDocument | null> {
    // autoIndex builds lazily; the partial unique index must exist before the first insert.
    await this.model.init();
    try {
      const created = await this.model.create({
        ...data,
        status: 'served',
        servedAt: new Date(),
        goldCorrect: null,
        credited: false,
        creditsAwarded: 0,
      });
      return created.toObject();
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  }

  /**
   * Atomically flips the outstanding row to voted with its judged outcome; null when this pair is
   * not outstanding for the user. Judging must happen before this call: the row stays 'served',
   * holding the one-outstanding lock, until the outcome is final.
   */
  async recordVote(userId: string, pairId: string, outcome: ArenaVoteOutcome): Promise<IArenaVoteDocument | null> {
    const updated = await this.model.findOneAndUpdate(
      { userId, pairId, status: 'served' },
      { $set: { status: 'voted', ...outcome } },
      { new: true }
    );
    return updated?.toObject() ?? null;
  }

  async goldRecord(userId: string): Promise<ArenaGoldRecord> {
    const [row] = await this.model.aggregate<ArenaGoldRecord>([
      { $match: { userId, status: 'voted', isGold: true, rejectReason: { $ne: 'too_fast' } } },
      {
        $group: {
          _id: null,
          answered: { $sum: 1 },
          correct: { $sum: { $cond: [{ $eq: ['$goldCorrect', true] }, 1, 0] } },
        },
      },
    ]);
    return { answered: row?.answered ?? 0, correct: row?.correct ?? 0 };
  }

  countCreditedSince(userId: string, since: Date): Promise<number> {
    return this.model.countDocuments({ userId, credited: true, votedAt: { $gte: since } });
  }

  async creditsEarned(userId: string): Promise<number> {
    const [row] = await this.model.aggregate<{ total: number }>([
      { $match: { userId, credited: true } },
      { $group: { _id: null, total: { $sum: '$creditsAwarded' } } },
    ]);
    return row?.total ?? 0;
  }

  async totals(): Promise<ArenaVoteTotals> {
    const [row] = await this.model.aggregate<ArenaVoteTotals>([
      { $match: { status: 'voted' } },
      {
        $group: {
          _id: null,
          votes: { $sum: 1 },
          credited: { $sum: { $cond: ['$credited', 1, 0] } },
          creditsAwarded: { $sum: '$creditsAwarded' },
        },
      },
    ]);
    return { votes: row?.votes ?? 0, credited: row?.credited ?? 0, creditsAwarded: row?.creditsAwarded ?? 0 };
  }

  async rejectionCounts(): Promise<Partial<Record<ArenaRejectReason, number>>> {
    const rows = await this.model.aggregate<{ _id: ArenaRejectReason; count: number }>([
      { $match: { status: 'voted', rejectReason: { $exists: true } } },
      { $group: { _id: '$rejectReason', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(row => [row._id, row.count]));
  }

  /** Every rater with at least one voted gold answer. */
  goldRaters(): Promise<ArenaRaterSummary[]> {
    return this.model.aggregate<ArenaRaterSummary>([
      { $match: { status: 'voted', isGold: true, rejectReason: { $ne: 'too_fast' } } },
      {
        $group: {
          _id: '$userId',
          answered: { $sum: 1 },
          correct: { $sum: { $cond: [{ $eq: ['$goldCorrect', true] }, 1, 0] } },
        },
      },
      { $project: { _id: 0, userId: '$_id', answered: 1, correct: 1 } },
    ]);
  }

  async distinctRaterCount(): Promise<number> {
    const raters = await this.model.distinct('userId', { status: 'voted' });
    return raters.length;
  }

  /** Voted, non-gold votes from the given raters, for the win-rate rollup. Too-fast clicks are not judgment. */
  async votesByRaters(userIds: string[]): Promise<ArenaRatedVote[]> {
    const rows = await this.model
      .find(
        { userId: { $in: userIds }, status: 'voted', isGold: false, rejectReason: { $ne: 'too_fast' } },
        { userId: 1, pairId: 1, choice: 1 }
      )
      .lean<{ userId: string; pairId: string; choice: ArenaChoice }[]>();
    return rows.map(({ userId, pairId, choice }) => ({ userId, pairId, choice }));
  }
}

export const arenaVoteRepository = new ArenaVoteRepository(ArenaVote);
