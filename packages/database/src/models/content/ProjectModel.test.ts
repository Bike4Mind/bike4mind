import { describe, it, expect, vi, beforeEach } from 'vitest';
import type mongoose from 'mongoose';
import { ProjectRepository } from './ProjectModel';

/**
 * Regression guard for issue #610: the "user is a member" arm of searchAccessible
 * must query the stored membership path `users.userId` (rows are
 * { userId, permissions, projectId } - see sharingService pushShareable), NOT the
 * nonexistent `users.id`, which matched no documents and hid shared projects from
 * the invitee's project search.
 *
 * Call-shape assertion (mock model), mirroring ArtifactModel.test.ts - avoids
 * pulling in mongodb-memory-server for a query-path check.
 */

interface ChainableQuery {
  skip: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  sort: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

describe('ProjectRepository.searchAccessible membership path (#610)', () => {
  let mockFind: ReturnType<typeof vi.fn>;
  let repo: ProjectRepository;

  beforeEach(() => {
    const query: ChainableQuery = {
      skip: vi.fn(() => query),
      limit: vi.fn(() => query),
      sort: vi.fn(() => query),
      exec: vi.fn().mockResolvedValue([]),
    };
    mockFind = vi.fn(() => query);

    const mockModel = {
      find: mockFind,
      countDocuments: vi.fn().mockResolvedValue(0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as mongoose.Model<any>;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo = new ProjectRepository(mockModel as any, { shareable: {} as any });
  });

  it('queries the stored users.userId path for the member arm, never users.id', async () => {
    await repo.searchAccessible('user_1', '', {}, { page: 1, limit: 10 }, { by: 'updatedAt', direction: 'desc' });

    const [conditions] = mockFind.mock.calls[0] as [{ $or: Array<Record<string, unknown>> }];
    expect(conditions.$or).toEqual(expect.arrayContaining([{ userId: 'user_1' }, { 'users.userId': 'user_1' }]));
    expect(conditions.$or.flatMap(clause => Object.keys(clause))).not.toContain('users.id');
  });
});
