import { describe, it, expect } from 'vitest';
import { fileTagRepository } from '../models/content/TagModel';
import { setupMongoTest } from '../__test__/utils';
import { IFileTag, TagType } from '@bike4mind/common';

/**
 * Real-Mongo coverage for the lookup every tag-creation path uses to decide whether a name is
 * already taken. A mock cannot prove what the regex actually matches, and two of the facts here are
 * load-bearing: that the match folds case (so the guard sees the collision the count aggregate
 * cannot) and that it is anchored and escaped (so `run2-alpha` is not reported as taken by
 * `run2-alphabet`, and a name carrying regex metacharacters matches only itself).
 */
setupMongoTest();

describe('FileTagRepository.findByFoldedNameAndUserId', () => {
  const userId = 'folded-lookup-user';
  const otherUserId = 'someone-else';

  // setupMongoTest drops the database between tests, so each case starts empty.
  const seed = (name: string, owner: string = userId) =>
    fileTagRepository.create({
      userId: owner,
      name,
      type: TagType.FILE,
      fileCount: 0,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Omit<IFileTag, 'id' | 'createdAt' | 'updatedAt'>);

  it('finds a tag whose stored name differs only by case', async () => {
    await seed('run2-alpha');

    const found = await fileTagRepository.findByFoldedNameAndUserId('RUN2-Alpha', userId);

    expect(found?.name).toBe('run2-alpha');
  });

  it('finds an exact match too', async () => {
    await seed('run2-alpha');

    expect((await fileTagRepository.findByFoldedNameAndUserId('run2-alpha', userId))?.name).toBe('run2-alpha');
  });

  it('folds the name it is given, so a padded query still collides', async () => {
    await seed('run2-alpha');

    expect(await fileTagRepository.findByFoldedNameAndUserId('  RUN2-ALPHA  ', userId)).not.toBeNull();
  });

  // Anchored: without ^...$ a longer name would report a shorter one as already taken.
  it('does not match a name that merely contains the query', async () => {
    await seed('run2-alphabet');

    expect(await fileTagRepository.findByFoldedNameAndUserId('run2-alpha', userId)).toBeNull();
  });

  // Escaped: a tag name is user text, so `a.b` must not match `axb`.
  it('treats regex metacharacters in the query as literals', async () => {
    await seed('axb');

    expect(await fileTagRepository.findByFoldedNameAndUserId('a.b', userId)).toBeNull();
  });

  it('finds a stored name carrying metacharacters by that exact name', async () => {
    await seed('q3 (draft)');

    expect((await fileTagRepository.findByFoldedNameAndUserId('Q3 (DRAFT)', userId))?.name).toBe('q3 (draft)');
  });

  // The guard is per user: one person's tag name must not block another's.
  it('scopes the lookup to the given user', async () => {
    await seed('run2-alpha', otherUserId);

    expect(await fileTagRepository.findByFoldedNameAndUserId('run2-alpha', userId)).toBeNull();
    expect(await fileTagRepository.findByFoldedNameAndUserId('run2-alpha', otherUserId)).not.toBeNull();
  });

  it('returns null when the user holds no such name', async () => {
    expect(await fileTagRepository.findByFoldedNameAndUserId('nothing-here', userId)).toBeNull();
  });
});
