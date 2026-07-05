import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { ArtifactRepository } from './ArtifactModel';
import type { IArtifactDocument } from './ArtifactModel';

/**
 * Anchor test for subclass overrides of BaseRepository.update.
 *
 * BaseModel.test.ts guards the base class; this file guards the call shape
 * on the override surface. If the `if (this._txn)` gate is ever removed from
 * a subclass override and `.session(this._txn)` is restored, this test fails.
 *
 * Same thenable-query stub pattern as BaseModel.test.ts, kept lightweight to
 * avoid pulling in mongodb-memory-server for a unit-level call-shape assertion.
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

describe('ArtifactRepository.update (#8997 override)', () => {
  let updateQuery: ThenableQuery<{ toJSON: () => Record<string, unknown> }>;
  let mockFindOneAndUpdate: ReturnType<typeof vi.fn>;
  let repo: ArtifactRepository;

  beforeEach(() => {
    updateQuery = makeQuery({
      toJSON: () => ({ id: 'art_1', name: 'renamed' }),
    });
    mockFindOneAndUpdate = vi.fn().mockReturnValue(updateQuery);

    const mockModel = {
      findOneAndUpdate: mockFindOneAndUpdate,
    } as unknown as mongoose.Model<IArtifactDocument>;

    repo = new ArtifactRepository(mockModel);
  });

  it('does NOT attach a session when no transaction is set (lets ALS propagate)', async () => {
    await repo.update({ id: 'art_1', name: 'renamed' } as Partial<IArtifactDocument>);
    expect(updateQuery.session).not.toHaveBeenCalled();
  });

  it('attaches the explicit session when a transaction is set', async () => {
    const session = { id: 'session' } as unknown as mongoose.mongo.ClientSession;
    repo.txn = session;

    await repo.update({ id: 'art_1', name: 'renamed' } as Partial<IArtifactDocument>);

    expect(updateQuery.session).toHaveBeenCalledTimes(1);
    expect(updateQuery.session).toHaveBeenCalledWith(session);
  });

  it('filters by the custom `id` field, not by `_id`', async () => {
    await repo.update({ id: 'art_1', name: 'renamed' } as Partial<IArtifactDocument>);
    const [filter] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ id: 'art_1' });
  });
});
