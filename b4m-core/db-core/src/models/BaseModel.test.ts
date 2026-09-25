import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from './BaseModel';

interface TestDoc extends IMongoDocument {
  userId: string;
  name: string;
}

// Concrete subclass since BaseRepository is abstract
class TestRepository extends BaseRepository<TestDoc> {
  constructor(model: mongoose.Model<TestDoc>) {
    super(model);
  }
}

/**
 * Build a thenable Mongoose-query stub. `update`/`updateMany` now await the query
 * directly and only call `.session()` when a transaction is set, so the
 * stub must be awaitable AND expose `.session()` as a spy for assertions.
 */
interface ThenableQuery<T = unknown> extends PromiseLike<T> {
  session: ReturnType<typeof vi.fn>;
}

const makeQuery = <T>(resolved: T): ThenableQuery<T> => {
  const query: ThenableQuery<T> = {
    session: vi.fn(() => query),
    then: (onFulfilled, onRejected) => Promise.resolve(resolved).then(onFulfilled, onRejected),
  };
  return query;
};

describe('BaseRepository', () => {
  describe('update', () => {
    let updateQuery: ThenableQuery<{ toJSON: () => Record<string, unknown> }>;
    let mockFindOneAndUpdate: ReturnType<typeof vi.fn>;
    let repo: TestRepository;

    beforeEach(() => {
      updateQuery = makeQuery({
        toJSON: () => ({ id: '507f1f77bcf86cd799439011', userId: 'user1', name: 'updated' }),
      });
      mockFindOneAndUpdate = vi.fn().mockReturnValue(updateQuery);

      const mockModel = {
        findOneAndUpdate: mockFindOneAndUpdate,
      } as unknown as mongoose.Model<TestDoc>;

      repo = new TestRepository(mockModel);
    });

    it('should not include id in the $set update data', async () => {
      await repo.update({ id: '507f1f77bcf86cd799439011', name: 'updated' });

      const [filter, update] = mockFindOneAndUpdate.mock.calls[0];

      // Filter should use the id for _id lookup
      expect(filter._id).toBeDefined();

      // $set should NOT contain the id field
      expect(update.$set).not.toHaveProperty('id');
      expect(update.$set).toEqual({ name: 'updated' });
    });

    it('should include userId in the $set update data', async () => {
      await repo.update({ id: '507f1f77bcf86cd799439011', userId: 'user1', name: 'new-name' });

      const [, update] = mockFindOneAndUpdate.mock.calls[0];

      expect(update.$set).toHaveProperty('userId', 'user1');
      expect(update.$set).toEqual({ userId: 'user1', name: 'new-name' });
    });

    it('should pass all non-id fields to $set', async () => {
      await repo.update({ id: '507f1f77bcf86cd799439011', userId: 'user1', name: 'new-name' });

      const [, update] = mockFindOneAndUpdate.mock.calls[0];

      expect(update.$set).toEqual({ userId: 'user1', name: 'new-name' });
      expect(update.$set).not.toHaveProperty('id');
    });

    // Regression: `update` is last-writer-wins even when the doc carries __v - it does NOT condition
    // on __v or $inc it. It also strips __v from $set so a stale whole-doc write never rewinds the
    // version key (which would disarm every `updateGuarded` writer on the collection).
    it('does not version-guard and strips __v from $set when the doc carries a numeric __v', async () => {
      await repo.update({ id: '507f1f77bcf86cd799439011', name: 'updated', __v: 3 } as Partial<TestDoc>);

      const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
      expect(filter.__v).toBeUndefined();
      expect(update.$inc).toBeUndefined();
      expect(update.$set).toEqual({ name: 'updated' });
    });

    it('should throw if id is missing', async () => {
      await expect(repo.update({ name: 'no-id' } as Partial<TestDoc>)).rejects.toThrow('id is required');
    });

    // Must not call .session(null), which overrides ALS transaction propagation.
    it('does NOT attach a session when no transaction is set (lets ALS propagate)', async () => {
      await repo.update({ id: '507f1f77bcf86cd799439011', name: 'updated' });
      expect(updateQuery.session).not.toHaveBeenCalled();
    });

    it('attaches the explicit session when a transaction is set', async () => {
      const session = { id: 'session' } as unknown as mongoose.mongo.ClientSession;
      repo.txn = session;

      await repo.update({ id: '507f1f77bcf86cd799439011', name: 'updated' });

      expect(updateQuery.session).toHaveBeenCalledTimes(1);
      expect(updateQuery.session).toHaveBeenCalledWith(session);
    });
  });

  describe('updateGuarded (version guard)', () => {
    const ID = '507f1f77bcf86cd799439011';
    let mockFindOneAndUpdate: ReturnType<typeof vi.fn>;
    let mockExists: ReturnType<typeof vi.fn>;
    let repo: TestRepository;

    const setup = (found: unknown, exists: unknown = null) => {
      mockFindOneAndUpdate = vi.fn().mockReturnValue(makeQuery(found === null ? null : { toJSON: () => found }));
      mockExists = vi.fn().mockReturnValue(makeQuery(exists));
      const mockModel = {
        findOneAndUpdate: mockFindOneAndUpdate,
        exists: mockExists,
        modelName: 'TestDoc',
      } as unknown as mongoose.Model<TestDoc>;
      repo = new TestRepository(mockModel);
    };

    it('conditions the write on __v and bumps it, stripping __v from $set', async () => {
      setup({ id: ID, name: 'updated', __v: 4 });
      await repo.updateGuarded({ id: ID, name: 'updated', __v: 3 } as Partial<TestDoc>);

      const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
      expect(filter._id).toBeDefined();
      expect(filter.__v).toBe(3);
      expect(update.$inc).toEqual({ __v: 1 });
      expect(update.$set).toEqual({ name: 'updated' }); // no id, no __v
    });

    it('degrades to a plain $set when the doc carries no numeric __v', async () => {
      setup({ id: ID, name: 'updated' });
      await repo.updateGuarded({ id: ID, name: 'updated' } as Partial<TestDoc>);

      const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
      expect(filter.__v).toBeUndefined();
      expect(update.$inc).toBeUndefined();
      expect(update.$set).toEqual({ name: 'updated' });
    });

    it('throws ConcurrencyConflictError when a versioned write misses but the row still exists', async () => {
      setup(null, { _id: ID }); // findOneAndUpdate matched nothing, but the doc is present -> lost race
      await expect(repo.updateGuarded({ id: ID, name: 'updated', __v: 3 } as Partial<TestDoc>)).rejects.toThrow(
        /Concurrent modification/
      );
    });

    it('returns null (not a conflict) when a versioned write misses and the row is gone', async () => {
      setup(null, null);
      const result = await repo.updateGuarded({ id: ID, name: 'updated', __v: 3 } as Partial<TestDoc>);
      expect(result).toBeNull();
    });

    it('does not probe existence on an unversioned miss', async () => {
      setup(null, null);
      const result = await repo.updateGuarded({ id: ID, name: 'updated' } as Partial<TestDoc>);
      expect(result).toBeNull();
      expect(mockExists).not.toHaveBeenCalled();
    });

    it('throws if id is missing', async () => {
      setup({ id: ID });
      await expect(repo.updateGuarded({ name: 'no-id' } as Partial<TestDoc>)).rejects.toThrow('id is required');
    });

    it('attaches the explicit session when a transaction is set', async () => {
      setup({ id: ID, name: 'updated', __v: 4 });
      const session = { id: 'session' } as unknown as mongoose.mongo.ClientSession;
      repo.txn = session;
      await repo.updateGuarded({ id: ID, name: 'updated', __v: 3 } as Partial<TestDoc>);
      const query = mockFindOneAndUpdate.mock.results[0].value as ThenableQuery;
      expect(query.session).toHaveBeenCalledWith(session);
    });
  });

  // The reserved `unset` option. A doc read back through findById is a plain object, so
  // `doc.field = undefined` keeps the key with an undefined value and `$set` drops it as an
  // absence - naming the field here is the only way `update` can clear it. Both cores honour it,
  // so a caller cannot discover that the guarded variant silently ignored it.
  describe('unset option', () => {
    const ID = '507f1f77bcf86cd799439011';
    let mockFindOneAndUpdate: ReturnType<typeof vi.fn>;
    let repo: TestRepository;

    beforeEach(() => {
      mockFindOneAndUpdate = vi.fn().mockReturnValue(makeQuery({ toJSON: () => ({ id: ID }) }));
      const mockModel = {
        findOneAndUpdate: mockFindOneAndUpdate,
        exists: vi.fn().mockReturnValue(makeQuery(null)),
        modelName: 'TestDoc',
      } as unknown as mongoose.Model<TestDoc>;
      repo = new TestRepository(mockModel);
    });

    it('turns the named fields into $unset and drops them from $set', async () => {
      await repo.update({ id: ID, name: 'updated', userId: undefined } as Partial<TestDoc>, { unset: ['userId'] });

      const [, update] = mockFindOneAndUpdate.mock.calls[0];
      expect(update.$unset).toEqual({ userId: '' });
      // Leaving the key in $set makes Mongo reject the whole write with a path conflict.
      expect(update.$set).toEqual({ name: 'updated' });
    });

    it('consumes the reserved key and forwards the rest of the bag to mongoose', async () => {
      await repo.update({ id: ID, name: 'updated' }, { unset: ['userId'], upsert: true });

      const [, , options] = mockFindOneAndUpdate.mock.calls[0];
      // `unset` is ours, not a findOneAndUpdate option - mongoose must never see it.
      expect(options).toEqual({ new: true, upsert: true });
    });

    it('emits no $unset operator when the option is absent', async () => {
      await repo.update({ id: ID, name: 'updated' });

      const [, update] = mockFindOneAndUpdate.mock.calls[0];
      expect(update).not.toHaveProperty('$unset');
    });

    it('applies the same treatment on the guarded path, alongside the version bump', async () => {
      await repo.updateGuarded({ id: ID, name: 'updated', userId: undefined, __v: 3 } as Partial<TestDoc>, {
        unset: ['userId'],
      });

      const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
      expect(filter.__v).toBe(3);
      expect(update.$inc).toEqual({ __v: 1 });
      expect(update.$unset).toEqual({ userId: '' });
      expect(update.$set).toEqual({ name: 'updated' });
    });
  });

  // updateMany had the same `.session(this._txn)` bug as update.
  describe('findById', () => {
    const makeRepo = (findByIdImpl: ReturnType<typeof vi.fn>) =>
      new TestRepository({ findById: findByIdImpl } as unknown as mongoose.Model<TestDoc>);

    it('resolves null for a string that cannot address a row, without querying', async () => {
      // The route's own `if (!doc) throw new NotFoundError(...)` is what answers the caller.
      // Reaching Mongoose here would raise a CastError instead, which the API error handler
      // cannot attribute to the caller.
      const findById = vi.fn();
      await expect(makeRepo(findById).findById('not-an-objectid')).resolves.toBeNull();
      expect(findById).not.toHaveBeenCalled();
    });

    it('does not treat a 12-character string as an id, matching mongoose 8', async () => {
      const findById = vi.fn();
      await expect(makeRepo(findById).findById('0123456789ab')).resolves.toBeNull();
      expect(findById).not.toHaveBeenCalled();
    });

    it('still queries for a valid id, including uppercase hex', async () => {
      const doc = { toJSON: () => ({ id: '507F1F77BCF86CD799439011', userId: 'user1', name: 'x' }) };
      const findById = vi.fn().mockResolvedValue(doc);
      await expect(makeRepo(findById).findById('507F1F77BCF86CD799439011')).resolves.toMatchObject({ name: 'x' });
      expect(findById).toHaveBeenCalledWith('507F1F77BCF86CD799439011');
    });

    it('still resolves null when a valid id matches no row', async () => {
      const findById = vi.fn().mockResolvedValue(null);
      await expect(makeRepo(findById).findById('507f1f77bcf86cd799439011')).resolves.toBeNull();
      expect(findById).toHaveBeenCalled();
    });
  });

  describe('updateMany', () => {
    let updateManyQuery: ThenableQuery<{ modifiedCount: number }>;
    let mockUpdateMany: ReturnType<typeof vi.fn>;
    let repo: TestRepository;

    beforeEach(() => {
      updateManyQuery = makeQuery({ modifiedCount: 1 });
      mockUpdateMany = vi.fn().mockReturnValue(updateManyQuery);

      const mockModel = {
        updateMany: mockUpdateMany,
      } as unknown as mongoose.Model<TestDoc>;

      repo = new TestRepository(mockModel);
    });

    it('does NOT attach a session when no transaction is set', async () => {
      await repo.updateMany({ userId: 'user1' }, { name: 'renamed' });
      expect(updateManyQuery.session).not.toHaveBeenCalled();
    });

    it('attaches the explicit session when a transaction is set', async () => {
      const session = { id: 'session' } as unknown as mongoose.mongo.ClientSession;
      repo.txn = session;

      await repo.updateMany({ userId: 'user1' }, { name: 'renamed' });

      expect(updateManyQuery.session).toHaveBeenCalledTimes(1);
      expect(updateManyQuery.session).toHaveBeenCalledWith(session);
    });
  });
});
