import mongoose, { ClientSession, FilterQuery, Model, Schema, Types, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  IMongoDocument,
  ISpendFreeze,
  ISpendFreezeRepository,
  SPEND_FREEZE_SCOPE_TYPES,
  SpendFreezeActor,
  SpendFreezeScope,
  SpendFreezeScopeType,
  SpendFreezeSubject,
} from '@bike4mind/common';

// Stored as an ObjectId (the entity type carries it as a string); `active` is the partial-index marker.
export type ISpendFreezeDocument = Omit<ISpendFreeze, 'scopeId'> &
  IMongoDocument & { scopeId: Types.ObjectId; active?: boolean };

const isSpendFreezeActor = (value: unknown): value is SpendFreezeActor => {
  if (typeof value !== 'object' || value === null) return false;
  const actor = value as Record<string, unknown>;
  if (actor.kind === 'admin') return typeof actor.userId === 'string' && actor.userId.length > 0;
  if (actor.kind === 'automatic') return typeof actor.rule === 'string' && actor.rule.length > 0;
  return false;
};

const actorField = (required: boolean) => ({
  type: Schema.Types.Mixed,
  required,
  validate: { validator: isSpendFreezeActor, message: 'actor must be an admin or automatic SpendFreezeActor' },
});

const SpendFreezeSchema = new Schema<ISpendFreezeDocument>(
  {
    scopeType: { type: String, required: true, enum: [...SPEND_FREEZE_SCOPE_TYPES] },
    scopeId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, required: true },
    actor: actorField(true),
    frozenAt: { type: Date, required: true },
    liftedAt: { type: Date },
    liftedBy: actorField(false),
    liftReason: { type: String },
    active: { type: Boolean },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Partial unique: at most one active freeze per scope; lifted rows are history. Mongo partial indexes
// reject `$exists: false`, so `active` is an internal marker set on create and unset on lift.
SpendFreezeSchema.index({ scopeType: 1, scopeId: 1 }, { unique: true, partialFilterExpression: { active: true } });
SpendFreezeSchema.index({ liftedAt: 1, frozenAt: -1 });
SpendFreezeSchema.index({ scopeType: 1, scopeId: 1, frozenAt: -1 });

export type ISpendFreezeModel = Model<ISpendFreezeDocument>;

const ACTIVE: FilterQuery<ISpendFreezeDocument> = { liftedAt: { $exists: false } };

const toObjectId = (id: string): Types.ObjectId => {
  if (!Types.ObjectId.isValid(id)) throw new Error(`Invalid spend freeze scope id: ${id}`);
  return new Types.ObjectId(id);
};

const toSpendFreeze = (doc: { toJSON(): unknown }): ISpendFreeze => {
  const { active: _active, ...json } = doc.toJSON() as ISpendFreeze & { scopeId: unknown; active?: boolean };
  return { ...json, scopeId: String(json.scopeId) };
};

const encodeCursor = (freeze: ISpendFreeze): string => `${freeze.frozenAt.toISOString()}|${freeze.id}`;

const decodeCursor = (cursor: string): { frozenAt: Date; id: Types.ObjectId } => {
  const [frozenAtRaw, id] = cursor.split('|');
  const frozenAt = new Date(frozenAtRaw ?? '');
  if (Number.isNaN(frozenAt.getTime()) || !id) throw new Error('Invalid spend freeze cursor');
  return { frozenAt, id: toObjectId(id) };
};

export class SpendFreezeRepository extends BaseRepository<ISpendFreezeDocument> implements ISpendFreezeRepository {
  constructor(model: ISpendFreezeModel) {
    super(model);
  }

  async findActiveForSubject(subject: SpendFreezeSubject): Promise<ISpendFreeze | null> {
    const candidates: [SpendFreezeScopeType, string | null | undefined][] = [
      ['User', subject.userId],
      ['Organization', subject.organizationId],
      ['apiKey', subject.apiKeyId],
    ];
    const clauses = candidates.flatMap(([scopeType, id]) => (id ? [{ scopeType, scopeId: toObjectId(id) }] : []));
    if (clauses.length === 0) return null;

    const doc = await this.model.findOne({ ...ACTIVE, $or: clauses });
    return doc ? toSpendFreeze(doc) : null;
  }

  async findActive(scope: SpendFreezeScope): Promise<ISpendFreeze | null> {
    const doc = await this.model.findOne({ ...ACTIVE, scopeType: scope.scopeType, scopeId: toObjectId(scope.scopeId) });
    return doc ? toSpendFreeze(doc) : null;
  }

  /** A duplicate active freeze surfaces Mongo's E11000 unchanged so the caller can map it. */
  async createActive(
    input: Omit<ISpendFreeze, 'id' | 'liftedAt' | 'liftedBy' | 'liftReason'>,
    opts: { session?: unknown } = {}
  ): Promise<ISpendFreeze> {
    const [doc] = await this.model.create([{ ...input, scopeId: toObjectId(input.scopeId), active: true }], {
      session: opts.session as ClientSession | undefined,
    });
    return toSpendFreeze(doc);
  }

  async liftActive(
    scope: SpendFreezeScope,
    lift: { liftedBy: SpendFreezeActor; liftReason: string; liftedAt: Date },
    opts: { session?: unknown } = {}
  ): Promise<ISpendFreeze | null> {
    const doc = await this.model.findOneAndUpdate(
      { ...ACTIVE, scopeType: scope.scopeType, scopeId: toObjectId(scope.scopeId) },
      { $set: lift, $unset: { active: 1 } },
      { new: true, session: opts.session as ClientSession | undefined }
    );
    return doc ? toSpendFreeze(doc) : null;
  }

  async listActive(q: {
    scopeType?: SpendFreezeScopeType;
    limit: number;
    cursor?: string;
  }): Promise<{ items: ISpendFreeze[]; nextCursor: string | null }> {
    const filter: FilterQuery<ISpendFreezeDocument> = { ...ACTIVE };
    if (q.scopeType) filter.scopeType = q.scopeType;
    if (q.cursor) {
      const { frozenAt, id } = decodeCursor(q.cursor);
      filter.$or = [{ frozenAt: { $lt: frozenAt } }, { frozenAt, _id: { $lt: id } }];
    }

    const docs = await this.model
      .find(filter)
      .sort({ frozenAt: -1, _id: -1 })
      .limit(q.limit + 1);
    const hasMore = docs.length > q.limit;
    const items = docs.slice(0, q.limit).map(toSpendFreeze);
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  }

  async listHistory(scope: SpendFreezeScope, limit: number): Promise<ISpendFreeze[]> {
    const docs = await this.model
      .find({ scopeType: scope.scopeType, scopeId: toObjectId(scope.scopeId) })
      .sort({ frozenAt: -1, _id: -1 })
      .limit(limit);
    return docs.map(toSpendFreeze);
  }
}

export const SpendFreeze =
  (mongoose.models['SpendFreeze'] as unknown as ISpendFreezeModel) ??
  model<ISpendFreezeDocument>('SpendFreeze', SpendFreezeSchema);
export const spendFreezeRepository = new SpendFreezeRepository(SpendFreeze);
