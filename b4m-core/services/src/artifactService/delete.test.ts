import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { deleteArtifact } from './delete';

describe('deleteArtifact (narrowed soft-delete write)', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  let db: { artifacts: { findOne: Mock; update: Mock } };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db = { artifacts: { findOne: vi.fn(), update: vi.fn().mockResolvedValue(undefined) } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes only the soft-delete fields for the owner', async () => {
    db.artifacts.findOne.mockResolvedValue({ id: 'art-1', userId: 'owner-1', title: 'T', content: 'C' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteArtifact('owner-1', { id: 'art-1' }, { db } as any);

    expect(db.artifacts.update).toHaveBeenCalledTimes(1);
    expect(db.artifacts.update.mock.calls[0]).toStrictEqual([
      { id: 'art-1', deletedAt: NOW, status: 'deleted', updatedAt: NOW },
    ]);
  });

  it('writes the same narrowed partial for a user listed in permissions.canDelete', async () => {
    db.artifacts.findOne.mockResolvedValue({
      id: 'art-2',
      userId: 'owner-1',
      permissions: { canDelete: ['helper-1'] },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteArtifact('helper-1', { id: 'art-2' }, { db } as any);

    expect(db.artifacts.update).toHaveBeenCalledTimes(1);
    expect(db.artifacts.update.mock.calls[0]).toStrictEqual([
      { id: 'art-2', deletedAt: NOW, status: 'deleted', updatedAt: NOW },
    ]);
  });

  it('does not write when the caller lacks delete access', async () => {
    db.artifacts.findOne.mockResolvedValue({ id: 'art-3', userId: 'owner-1' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deleteArtifact('stranger', { id: 'art-3' }, { db } as any)).rejects.toThrow(UnauthorizedError);
    expect(db.artifacts.update).not.toHaveBeenCalled();
  });

  it('does not write when the artifact is missing or already deleted', async () => {
    db.artifacts.findOne.mockResolvedValueOnce(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deleteArtifact('owner-1', { id: 'x' }, { db } as any)).rejects.toThrow(NotFoundError);

    db.artifacts.findOne.mockResolvedValueOnce({ id: 'y', userId: 'owner-1', deletedAt: NOW });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deleteArtifact('owner-1', { id: 'y' }, { db } as any)).rejects.toThrow(NotFoundError);
    expect(db.artifacts.update).not.toHaveBeenCalled();
  });
});
