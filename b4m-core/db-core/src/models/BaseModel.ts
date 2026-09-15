import { ConcurrencyConflictError, IBaseRepository, IMongoDocument } from '@bike4mind/common';
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
  /**
   * Update a document by id (last-writer-wins). The whole `data` field set is `$set` unconditionally,
   * so a concurrent write to a different field is silently overwritten. For lost-update-sensitive
   * writes use `updateGuarded`, which conditions the write on the read-time `__v` and throws
   * ConcurrencyConflictError instead of clobbering a racing writer.
   */
  async update(data: Partial<T>, options?: Record<string, unknown>): Promise<T | null> {
    if (!data.id) {
      throw new Error('id is required');
    }
    // Strip `id` from update data - it's used for identity only.
    const { id, ...updateData } = data;
    return this._plainUpdate({ _id: convertId(id) }, updateData as Record<string, unknown>, options);
  }
  /**
   * Opt-in optimistic-concurrency update. When `data` carries a numeric `__v` (a doc read via
   * findById/findOne, which retain it), the write is conditioned on that `__v` and bumps it, so a
   * stale write - one whose doc a concurrent writer already advanced - matches nothing and throws
   * ConcurrencyConflictError instead of silently clobbering the winner (last-writer-wins). When `data`
   * carries no numeric `__v` (a partial patch, or a `versionKey:false` model) it degrades to a plain
   * `$set`: no version precondition, no false conflicts - identical to `update`.
   *
   * HAZARD for callers: a function that calls `updateGuarded` on the SAME in-memory doc twice without
   * refreshing it between calls makes the second call carry a stale `__v` and throw. Capture the
   * returned (version-bumped) doc between writes: `doc = await repo.updateGuarded(doc)`.
   */
  async updateGuarded(data: Partial<T>, options?: Record<string, unknown>): Promise<T | null> {
    if (!data.id) {
      throw new Error('id is required');
    }
    const { id, ...updateData } = data;
    return this._versionedUpdate({ _id: convertId(id) }, updateData as Record<string, unknown>, options);
  }
  /**
   * Shared plain-update core for `update` and the repos that override it with a non-`_id` identity
   * filter (e.g. ArtifactModel's custom `id`). Last-writer-wins: `$set` of `data`, no version
   * precondition. See `_versionedUpdate` for the opt-in guarded variant.
   */
  protected async _plainUpdate<D = T>(
    idFilter: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<D | null> {
    // Strip `__v` from the `$set`. A whole-doc `update` from a stale in-memory copy would otherwise
    // write the read-time version straight back, rewinding the monotonic counter `updateGuarded`
    // conditions on (findOneAndUpdate never auto-bumps `__v`) - a single plain write on the
    // collection would silently disarm every guarded writer on it. Plain `update` has no business
    // writing the version key: leave it untouched, neither writing nor bumping it.
    const { __v: _ignoredVersion, ...setData } = data as { __v?: unknown } & Record<string, unknown>;
    const query = this.model.findOneAndUpdate(
      idFilter as mongoose.FilterQuery<T>,
      { $set: setData } as mongoose.UpdateQuery<T>,
      { new: true, ...options }
    );
    // Only attach an explicit session when one is set. Passing `.session(null)` tells Mongoose "no
    // session", which overrides the global `transactionAsyncLocalStorage` propagation and silently
    // breaks atomicity for repo writes inside `withTransaction(async () => {...})`.
    if (this._txn) {
      query.session(this._txn);
    }
    const result = await query;
    return (result?.toJSON() as D) ?? null;
  }
  /**
   * Shared optimistic-concurrency core for `updateGuarded` and the repos that opt in with a non-`_id`
   * identity filter (e.g. ArtifactModel's custom `id`). `idFilter` is the identity predicate; `data`
   * is the field set to write and may carry a numeric `__v` read back from the doc. `__v` is stripped
   * out of `$set` and re-applied as an explicit `$inc: { __v: 1 }` - `findOneAndUpdate` does not
   * auto-bump the version key, and `$set`-ing the same key it is `$inc`-ing would collide.
   */
  protected async _versionedUpdate<D = T>(
    idFilter: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<D | null> {
    const { __v, ...setData } = data as { __v?: unknown } & Record<string, unknown>;
    const versioned = typeof __v === 'number';

    const filter = (versioned ? { ...idFilter, __v } : { ...idFilter }) as mongoose.FilterQuery<T>;
    const update = (versioned ? { $set: setData, $inc: { __v: 1 } } : { $set: setData }) as mongoose.UpdateQuery<T>;

    const query = this.model.findOneAndUpdate(filter, update, { new: true, ...options });
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity (see `_plainUpdate`).
    if (this._txn) {
      query.session(this._txn);
    }
    const result = await query;
    if (result) {
      return result.toJSON() as D;
    }
    // A versioned miss is ambiguous: either the row is gone, or a concurrent writer advanced `__v`
    // past ours. Only the race is worth surfacing; a genuine not-found keeps `update`'s null contract.
    if (versioned) {
      const existsQuery = this.model.exists(idFilter as mongoose.FilterQuery<T>);
      if (this._txn) existsQuery.session(this._txn);
      if (await existsQuery) {
        throw new ConcurrencyConflictError(this.model.modelName, { filter: idFilter });
      }
    }
    return null;
  }
  async updateMany(filter: Record<string, unknown>, data: Partial<T>, options?: Record<string, unknown>) {
    // Last-writer-wins, like `update`: a `$set` with no version precondition. There is no bulk
    // guarded variant - `updateGuarded` is per-document by design.
    const query = this.model.updateMany(filter, { $set: data }, options);
    // See `_plainUpdate` above: explicit `.session(null)` would defeat ALS propagation.
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
