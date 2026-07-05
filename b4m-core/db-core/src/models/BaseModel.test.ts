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

  // updateMany had the same `.session(this._txn)` bug as update.
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
