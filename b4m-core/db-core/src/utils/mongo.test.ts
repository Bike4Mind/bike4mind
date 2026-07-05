import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  compareMongoIds,
  convertId,
  convertIds,
  mongoExportedRecordConverter,
  isTransientTransactionError,
  withTransaction,
  softDeletePlugin,
} from './mongo';

describe('MongoDB Utility Functions', () => {
  describe('compareMongoIds', () => {
    it('should return true for matching IDs in different formats', () => {
      const objectId = new mongoose.Types.ObjectId();
      const stringId = objectId.toString();

      expect(compareMongoIds(objectId, stringId)).toBe(true);
      expect(compareMongoIds(stringId, objectId)).toBe(true);
      expect(compareMongoIds(stringId, stringId)).toBe(true);
    });

    it('should return false for different IDs', () => {
      const id1 = new mongoose.Types.ObjectId();
      const id2 = new mongoose.Types.ObjectId();

      expect(compareMongoIds(id1, id2)).toBe(false);
    });
  });

  describe('convertId', () => {
    it('should convert string ID to ObjectId', () => {
      const objectId = new mongoose.Types.ObjectId();
      const stringId = objectId.toString();

      expect(convertId(stringId)).toEqual(objectId);
    });

    it('should return same ObjectId when passed an ObjectId', () => {
      const objectId = new mongoose.Types.ObjectId();

      expect(convertId(objectId)).toBe(objectId);
    });
  });

  describe('convertIds', () => {
    it('should convert array of string IDs to ObjectIds', () => {
      const objectId1 = new mongoose.Types.ObjectId();
      const objectId2 = new mongoose.Types.ObjectId();
      const stringIds = [objectId1.toString(), objectId2.toString()];

      expect(convertIds(stringIds)).toEqual([objectId1, objectId2]);
    });
  });

  describe('mongoExportedRecordConverter', () => {
    it('should convert $oid to ObjectId', () => {
      const objectId = new mongoose.Types.ObjectId();
      const input = { _id: { $oid: objectId.toString() } };
      const expected = { _id: objectId };

      expect(mongoExportedRecordConverter(input)).toEqual(expected);
    });

    it('should convert $date to Date', () => {
      const date = new Date('2024-01-01');
      const input = { createdAt: { $date: { $numberLong: date.getTime().toString() } } };
      const expected = { createdAt: date };

      expect(mongoExportedRecordConverter(input)).toEqual(expected);
    });

    it('should handle nested objects and arrays', () => {
      const objectId = new mongoose.Types.ObjectId();
      const date = new Date('2024-01-01');
      const input = {
        _id: { $oid: objectId.toString() },
        items: [{ date: { $date: { $numberLong: date.getTime().toString() } } }],
        nested: {
          ref: { $oid: objectId.toString() },
        },
      };
      const expected = {
        _id: objectId,
        items: [{ date }],
        nested: { ref: objectId },
      };

      expect(mongoExportedRecordConverter(input)).toEqual(expected);
    });
  });

  describe('isTransientTransactionError', () => {
    it('should return true for WriteConflict (code 112)', () => {
      const error = { code: 112, message: 'Write conflict' };
      expect(isTransientTransactionError(error)).toBe(true);
    });

    it('should return true for NoSuchTransaction (code 251)', () => {
      const error = { code: 251, message: 'Transaction was aborted' };
      expect(isTransientTransactionError(error)).toBe(true);
    });

    it('should return true for error with TransientTransactionError label', () => {
      const error = {
        code: 999,
        errorLabels: ['TransientTransactionError'],
        message: 'Some transient error',
      };
      expect(isTransientTransactionError(error)).toBe(true);
    });

    it('should return true for WriteConflict with TransientTransactionError label', () => {
      const error = {
        code: 112,
        errorLabels: ['TransientTransactionError'],
        message: 'Write conflict during plan execution',
      };
      expect(isTransientTransactionError(error)).toBe(true);
    });

    it('should return false for validation errors', () => {
      const error = { code: 121, message: 'Document failed validation' };
      expect(isTransientTransactionError(error)).toBe(false);
    });

    it('should return false for authentication errors', () => {
      const error = { code: 18, message: 'Authentication failed' };
      expect(isTransientTransactionError(error)).toBe(false);
    });

    it('should return false for duplicate key errors', () => {
      const error = { code: 11000, message: 'Duplicate key error' };
      expect(isTransientTransactionError(error)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isTransientTransactionError(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isTransientTransactionError(undefined)).toBe(false);
    });

    it('should return false for non-object errors', () => {
      expect(isTransientTransactionError('error string')).toBe(false);
      expect(isTransientTransactionError(123)).toBe(false);
    });

    it('should return false for errors without code or labels', () => {
      const error = { message: 'Generic error' };
      expect(isTransientTransactionError(error)).toBe(false);
    });
  });

  describe('softDeletePlugin', () => {
    let schema: mongoose.Schema;
    let mockUpdateOne: ReturnType<typeof vi.fn>;
    let mockUpdateMany: ReturnType<typeof vi.fn>;
    let mockHardDeleteOne: ReturnType<typeof vi.fn>;
    let fakeThis: {
      collection: {
        updateOne: typeof mockUpdateOne;
        updateMany: typeof mockUpdateMany;
        deleteOne: typeof mockHardDeleteOne;
      };
    };

    beforeEach(() => {
      mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
      mockUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 2 });
      mockHardDeleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
      fakeThis = {
        collection: {
          updateOne: mockUpdateOne,
          updateMany: mockUpdateMany,
          deleteOne: mockHardDeleteOne,
        },
      };
      schema = new mongoose.Schema({});
      softDeletePlugin(schema);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('deleteOne: casts bare string _id to ObjectId before hitting the raw driver', async () => {
      const id = new mongoose.Types.ObjectId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteOne as any).call(fakeThis, { _id: id.toString() });
      const [passedFilter] = mockUpdateOne.mock.calls[0];
      expect(passedFilter._id).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter._id).toEqual(id);
    });

    it('deleteMany: casts string IDs inside $in to ObjectId', async () => {
      const id = new mongoose.Types.ObjectId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteMany as any).call(fakeThis, { _id: { $in: [id.toString()] } });
      const [passedFilter] = mockUpdateMany.mock.calls[0];
      expect(passedFilter._id.$in[0]).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter._id.$in[0]).toEqual(id);
    });

    it('deleteMany: idempotent — mixed ObjectId + string in $in both become ObjectId', async () => {
      const id1 = new mongoose.Types.ObjectId();
      const id2 = new mongoose.Types.ObjectId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteMany as any).call(fakeThis, { _id: { $in: [id1, id2.toString()] } });
      const [passedFilter] = mockUpdateMany.mock.calls[0];
      expect(passedFilter._id.$in[0]).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter._id.$in[1]).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter._id.$in[0]).toEqual(id1);
      expect(passedFilter._id.$in[1]).toEqual(id2);
    });

    it('deleteMany: filter without _id passes through without modification', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteMany as any).call(fakeThis, { userId: 'some-user' });
      const [passedFilter] = mockUpdateMany.mock.calls[0];
      expect(passedFilter._id).toBeUndefined();
      expect(passedFilter.userId).toBe('some-user');
    });

    it('deleteOne: hardDelete option skips soft-delete but still casts _id to ObjectId', async () => {
      const id = new mongoose.Types.ObjectId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteOne as any).call(fakeThis, { _id: id.toString() }, { hardDelete: true });
      expect(mockHardDeleteOne).toHaveBeenCalledTimes(1);
      expect(mockUpdateOne).not.toHaveBeenCalled();
      const [passedFilter] = mockHardDeleteOne.mock.calls[0];
      expect(passedFilter._id).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter._id).toEqual(id);
    });

    it('deleteMany: hardDelete option skips soft-delete but still casts _id.$in to ObjectId', async () => {
      const id = new mongoose.Types.ObjectId();
      const mockHardDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
      const fakeThisWithHardDeleteMany = {
        collection: { ...fakeThis.collection, deleteMany: mockHardDeleteMany },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteMany as any).call(
        fakeThisWithHardDeleteMany,
        { _id: { $in: [id.toString()] } },
        { hardDelete: true }
      );
      expect(mockHardDeleteMany).toHaveBeenCalledTimes(1);
      expect(mockUpdateMany).not.toHaveBeenCalled();
      const [passedFilter] = mockHardDeleteMany.mock.calls[0];
      expect(passedFilter._id.$in[0]).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter._id.$in[0]).toEqual(id);
    });

    it('deleteMany: casts _id.$ne string to ObjectId', async () => {
      const id = new mongoose.Types.ObjectId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteMany as any).call(fakeThis, { _id: { $ne: id.toString() } });
      const [passedFilter] = mockUpdateMany.mock.calls[0];
      expect(passedFilter._id.$ne).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter._id.$ne).toEqual(id);
    });

    it('deleteMany: recurses into $or and casts nested _id string to ObjectId', async () => {
      const id = new mongoose.Types.ObjectId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- calling static as plain fn to inject fake `this`
      await (schema.statics.deleteMany as any).call(fakeThis, {
        $or: [{ _id: id.toString() }, { userId: 'some-user' }],
      });
      const [passedFilter] = mockUpdateMany.mock.calls[0];
      expect(passedFilter.$or[0]._id).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(passedFilter.$or[0]._id).toEqual(id);
      expect(passedFilter.$or[1].userId).toBe('some-user');
    });
  });

  describe('withTransaction retry behavior', () => {
    let mockTransaction: ReturnType<typeof vi.fn<typeof mongoose.connection.transaction>>;

    beforeEach(() => {
      mockTransaction = vi.fn<typeof mongoose.connection.transaction>();
      vi.spyOn(mongoose.connection, 'transaction').mockImplementation(mockTransaction);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should succeed on first attempt without retry', async () => {
      mockTransaction.mockResolvedValueOnce('success');

      const result = await withTransaction(async () => 'success');

      expect(result).toBe('success');
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient error and succeed', async () => {
      const transientError = { code: 112, errorLabels: ['TransientTransactionError'] };
      mockTransaction.mockRejectedValueOnce(transientError).mockResolvedValueOnce('success after retry');

      const result = await withTransaction(async () => 'success after retry');

      expect(result).toBe('success after retry');
      expect(mockTransaction).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries exhausted', async () => {
      const transientError = { code: 112, errorLabels: ['TransientTransactionError'], message: 'WriteConflict' };
      mockTransaction.mockRejectedValue(transientError);

      await expect(withTransaction(async () => 'never', { maxRetries: 2 })).rejects.toEqual(transientError);

      // Initial attempt + 2 retries = 3 calls
      expect(mockTransaction).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-transient errors', async () => {
      const permanentError = { code: 11000, message: 'Duplicate key error' };
      mockTransaction.mockRejectedValue(permanentError);

      await expect(withTransaction(async () => 'never')).rejects.toEqual(permanentError);

      // Should fail immediately without retries
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('should respect custom maxRetries option', async () => {
      const transientError = { code: 112, errorLabels: ['TransientTransactionError'] };
      mockTransaction.mockRejectedValue(transientError);

      await expect(withTransaction(async () => 'never', { maxRetries: 1 })).rejects.toEqual(transientError);

      // Initial attempt + 1 retry = 2 calls
      expect(mockTransaction).toHaveBeenCalledTimes(2);
    });

    it('should apply jitter to retry delays (delays are not identical)', async () => {
      const transientError = { code: 112, errorLabels: ['TransientTransactionError'] };
      const delays: number[] = [];

      // Spy on setTimeout to capture delays
      vi.spyOn(global, 'setTimeout').mockImplementation((fn: () => void, delay?: number) => {
        if (delay && delay > 0) {
          delays.push(delay);
        }
        // Execute immediately for test speed
        fn();
        return 0 as unknown as NodeJS.Timeout;
      });

      mockTransaction
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce('success');

      await withTransaction(async () => 'success');

      // Restore setTimeout
      vi.mocked(global.setTimeout).mockRestore();

      // Should have 2 delays (for 2 retries)
      expect(delays.length).toBe(2);

      // Base delays are 100ms and 200ms, with 25% jitter
      // First delay: 100 + (0-25) = 100-125ms
      // Second delay: 200 + (0-50) = 200-250ms
      expect(delays[0]).toBeGreaterThanOrEqual(100);
      expect(delays[0]).toBeLessThanOrEqual(125);
      expect(delays[1]).toBeGreaterThanOrEqual(200);
      expect(delays[1]).toBeLessThanOrEqual(250);
    });
  });
});
