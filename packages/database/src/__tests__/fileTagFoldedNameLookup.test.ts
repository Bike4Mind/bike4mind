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

  // A pair the guard now prevents but legacy data can hold. findOrCreateByNameAndUserId resolves its
  // upsert onto whichever document this returns, so an unordered read could settle on a different
  // one per call.
  it('picks the same, oldest document every time when a legacy pair exists', async () => {
    await seed('run2-alpha');
    await seed('RUN2-Alpha');

    const picks = await Promise.all([
      fileTagRepository.findByFoldedNameAndUserId('RUN2-ALPHA', userId),
      fileTagRepository.findByFoldedNameAndUserId('run2-alpha', userId),
      fileTagRepository.findByFoldedNameAndUserId('Run2-Alpha', userId),
    ]);

    expect(picks.map(p => p?.name)).toEqual(['run2-alpha', 'run2-alpha', 'run2-alpha']);
  });
});

/**
 * The upsert built on that lookup. Its filter matches the name exactly, so it needs the fold to
 * avoid minting a second document for a name the user already holds - its live caller copies tag
 * names off a file OWNED BY SOMEONE ELSE when an invite is accepted, so the casing is not the
 * recipient's to begin with.
 */
describe('FileTagRepository.findOrCreateByNameAndUserId', () => {
  const userId = 'find-or-create-user';

  const countHeld = async () => (await fileTagRepository.findAllByUserId(userId)).length;

  it('creates the tag when the user holds no such name', async () => {
    const tag = await fileTagRepository.findOrCreateByNameAndUserId('invoices', userId, { color: '#FF0000' });

    expect(tag?.name).toBe('invoices');
    expect(tag?.color).toBe('#FF0000');
    expect(await countHeld()).toBe(1);
  });

  it('reuses the existing document instead of minting a case variant', async () => {
    await fileTagRepository.findOrCreateByNameAndUserId('invoices', userId, {});

    const tag = await fileTagRepository.findOrCreateByNameAndUserId('INVOICES', userId, {});

    expect(tag?.name).toBe('invoices');
    expect(await countHeld()).toBe(1);
  });

  it('keeps the casing the user already holds rather than adopting the caller spelling', async () => {
    await fileTagRepository.findOrCreateByNameAndUserId('Invoices', userId, {});

    const tag = await fileTagRepository.findOrCreateByNameAndUserId('invoices', userId, {});

    expect(tag?.name).toBe('Invoices');
  });

  it('trims a name it is creating fresh', async () => {
    const tag = await fileTagRepository.findOrCreateByNameAndUserId('  invoices  ', userId, {});

    expect(tag?.name).toBe('invoices');
  });

  it('still treats a genuinely different name as its own tag', async () => {
    await fileTagRepository.findOrCreateByNameAndUserId('invoices', userId, {});
    await fileTagRepository.findOrCreateByNameAndUserId('invoices-2024', userId, {});

    expect(await countHeld()).toBe(2);
  });

  it('scopes the reuse to the caller, so one user cannot absorb another name', async () => {
    await fileTagRepository.findOrCreateByNameAndUserId('invoices', 'somebody-else', {});

    const tag = await fileTagRepository.findOrCreateByNameAndUserId('INVOICES', userId, {});

    expect(tag?.name).toBe('INVOICES');
    expect(await countHeld()).toBe(1);
  });
});
