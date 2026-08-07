import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { createFileTag } from './createFileTag';
import { IFileTagRepository } from '@bike4mind/common';

type Repo = Pick<IFileTagRepository, 'create' | 'findByFoldedNameAndUserId'>;

/**
 * The auto-create door: research tasks name their own tag, so unlike tagService/create this cannot
 * refuse a collision, it has to converge on the document the user already holds. Minting a second
 * one is how a case pair appeared with no user action at all.
 */
describe('tagService - createFileTag', () => {
  const userId = 'test-user-123';
  let repo: Repo;
  let adapters: { db: { fileTags: Repo } };

  beforeEach(() => {
    repo = {
      create: vi.fn(),
      findByFoldedNameAndUserId: vi.fn().mockResolvedValue(null),
    };
    adapters = { db: { fileTags: repo } };
  });

  it('creates the tag when the user holds no such name', async () => {
    (repo.create as Mock).mockResolvedValueOnce({ id: 'new-1', name: 'Research: Q3' });

    const tag = await createFileTag(userId, { name: 'Research: Q3', color: '#FF0000' }, adapters);

    expect(tag).toEqual({ id: 'new-1', name: 'Research: Q3' });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId, name: 'Research: Q3', color: '#FF0000' })
    );
  });

  it('reuses the document the user already holds in a different casing', async () => {
    (repo.findByFoldedNameAndUserId as Mock).mockResolvedValueOnce({ id: 'held-1', name: 'research: q3' });

    const tag = await createFileTag(userId, { name: 'Research: Q3' }, adapters);

    expect(tag).toEqual({ id: 'held-1', name: 'research: q3' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('looks the name up under the caller id', async () => {
    await createFileTag(userId, { name: 'Research: Q3' }, adapters);

    expect(repo.findByFoldedNameAndUserId).toHaveBeenCalledWith('Research: Q3', userId);
  });

  it('trims the name before looking it up and before storing it', async () => {
    (repo.create as Mock).mockResolvedValueOnce({ id: 'new-1' });

    await createFileTag(userId, { name: '  Research: Q3  ' }, adapters);

    expect(repo.findByFoldedNameAndUserId).toHaveBeenCalledWith('Research: Q3', userId);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Research: Q3' }));
  });

  // A lake membership tag IS reachable here - accepting an invite to a shared lake file mints one -
  // so this door must not refuse it the way create/update/remove do.
  it('does not refuse a data lake membership name', async () => {
    (repo.create as Mock).mockResolvedValueOnce({ id: 'lake-1', name: 'datalake:acme' });

    await expect(createFileTag(userId, { name: 'datalake:acme' }, adapters)).resolves.toEqual({
      id: 'lake-1',
      name: 'datalake:acme',
    });
  });

  it('rejects a name that is only whitespace', async () => {
    await expect(createFileTag(userId, { name: '  ' }, adapters)).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  // A concurrent creation between the lookup and the write. This runs in a background task, so
  // converge on whatever landed instead of failing the whole research run.
  it('returns the winner when a concurrent create takes the name first', async () => {
    (repo.create as Mock).mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
    (repo.findByFoldedNameAndUserId as Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'raced-1', name: 'Research: Q3' });

    await expect(createFileTag(userId, { name: 'Research: Q3' }, adapters)).resolves.toEqual({
      id: 'raced-1',
      name: 'Research: Q3',
    });
  });

  it('rethrows a duplicate error when the re-read still finds nothing', async () => {
    (repo.create as Mock).mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));

    await expect(createFileTag(userId, { name: 'Research: Q3' }, adapters)).rejects.toThrow('E11000');
  });

  it('does not swallow an unrelated write failure', async () => {
    (repo.create as Mock).mockRejectedValueOnce(new Error('connection reset'));

    await expect(createFileTag(userId, { name: 'Research: Q3' }, adapters)).rejects.toThrow('connection reset');
  });
});
