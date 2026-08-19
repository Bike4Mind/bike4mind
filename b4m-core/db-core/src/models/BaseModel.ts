import { IBaseRepository, IMongoDocument } from '@bike4mind/common';
import mongoose from 'mongoose';
import { convertId } from '../utils/mongo';

/**
 * A MongoDB-based base abstract repository
 */
abstract class BaseRepository<T extends IMongoDocument> implements IBaseRepository<T> {
  protected _txn: mongoose.mongo.ClientSession | null;
  constructor(protected model: mongoose.Model<T>) {
    this._txn = null;
  }

  set txn(value: mongoose.mongo.ClientSession | null) {
    this._txn = value;
  }

  async find(filter: Record<string, unknown>, options: Record<string, unknown> = {}) {
    // Separate projection from query options (skip, limit, sort)
    const { skip, limit, sort, ...projection } = options;

    let query = this.model.find(filter, Object.keys(projection).length > 0 ? projection : undefined);

    if (skip !== undefined) query = query.skip(Number(skip));
    if (limit !== undefined) query = query.limit(Number(limit));
    if (sort) query = query.sort(sort as any);

    return (await query).map(d => d.toObject());
  }
  async findOne(filter: Record<string, unknown>) {
    const result = await this.model.findOne(filter);
    return result?.toJSON() as T | null;
  }
  async create(data: Omit<T, 'id' | 'updatedAt' | 'createdAt'>) {
    const result = await this.model.create(data);
    return result.toObject();
  }
  async findById(id: string) {
    const result = await this.model.findById(id);
    return result?.toJSON() as T | null;
  }
  async update(data: Partial<T>, options?: Record<string, unknown>): Promise<T | null> {
    if (!data.id) {
      throw new Error('id is required');
    }

    // Strip `id` from update data - it's used for identity only.
    const { id, ...updateData } = data;

    const query = this.model.findOneAndUpdate(
      {
        _id: convertId(id),
      },
      { $set: updateData as Partial<T> },
      { new: true, ...options }
    );

    // Only attach an explicit session when one is set. Passing `.session(null)`
    // tells Mongoose "no session", which overrides the global
    // `transactionAsyncLocalStorage` propagation and silently breaks atomicity
    // for repo writes inside `withTransaction(async () => {...})`.
    if (this._txn) {
      query.session(this._txn);
    }

    const result = await query;

    return result?.toJSON() as T | null;
  }
  async updateMany(filter: Record<string, unknown>, data: Partial<T>, options?: Record<string, unknown>) {
    const query = this.model.updateMany(filter, { $set: data }, options);
    // See `update` above: explicit `.session(null)` would defeat ALS propagation.
    if (this._txn) {
      query.session(this._txn);
    }
    return query;
  }
  /**
   * Delete by id. Routes to `softDeletePlugin` (soft delete) for the plugin-carrying models, or a
   * hard delete for the rest.
   *
   * HAZARD - do NOT pass `{ session }` here. Mongoose's `transactionAsyncLocalStorage` guard is a
   * key-PRESENCE check (`!Object.hasOwn(options, 'session')`), so passing `{ session: undefined }`
   * SETS the key and suppresses ALS injection: the delete then escapes the caller's
   * `withTransaction` and commits immediately, surviving a rollback - a data-loss path on hard
   * deletes (org-groups #1228, mechanism 2; same trap the `update`/`updateMany` `.session(null)`
   * note above guards against). Omitting the argument lets ALS inject the active session for
   * Mongoose-query (hard) deletes, and `withAlsSession` inside `softDeletePlugin` does the same for
   * the raw-driver soft-delete path. `_txn` is null on every path that reaches `delete()` (the only
   * `.txn` setter runs inside a `withTransaction` callback, which ALS already covers), so it is
   * deliberately not threaded here.
   */
  async delete(id: string): Promise<unknown> {
    return this.model.deleteOne({ _id: convertId(id) });
  }
  count(filter: Record<string, unknown>) {
    return this.model.countDocuments(filter);
  }
}

export default BaseRepository;
