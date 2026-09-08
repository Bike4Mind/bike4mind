import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { IFileTag, TagType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { fileTagRepository } from './TagModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

const tags = () => mongoose.connection.db!.collection('tags');
const fileTagModel = () => mongoose.model('Tag').discriminators![TagType.FILE];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // createMongoServer gives a bare database; the { userId, name } unique index is what makes the
  // one-document assertions below mean anything.
  await mongoose.model('Tag').ensureIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await tags().deleteMany({});
});

const PAST = new Date('2020-01-01T00:00:00Z');

const seed = (name: string, userId: string, extra: Record<string, unknown> = {}) =>
  tags().insertOne({
    name,
    userId,
    type: TagType.FILE,
    lastActivityAt: PAST,
    createdAt: PAST,
    updatedAt: PAST,
    ...extra,
  });

// The stored fileCount counter was removed: counts are derived per read by tagService/listFileTags.
// These pin the two things that removal could have broken - that no write path resurrects the
// column, and that the methods which used to share a write with the counter still refresh
// `lastActivityAt`, which the sidebar's recent ordering sorts on. Only those methods; see
// touchLastActivityBy's docstring for the callers that change a file's tags without it.
describe('FileTagRepository after the fileCount removal', () => {
  const userId = 'u-tag-activity';

  it('creates a file tag with no fileCount key', async () => {
    await fileTagRepository.create({
      name: 'invoices',
      userId,
      type: TagType.FILE,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Omit<IFileTag, 'id' | 'createdAt' | 'updatedAt'>);

    const stored = await tags().findOne({ name: 'invoices', userId });
    expect(stored).not.toBeNull();
    expect('fileCount' in stored!).toBe(false);
  });

  describe('touchLastActivityBy', () => {
    it('advances lastActivityAt without writing a fileCount', async () => {
      await seed('invoices', userId);

      await fileTagRepository.touchLastActivityBy({ name: 'invoices', userId });

      const stored = await tags().findOne({ name: 'invoices', userId });
      expect(stored!.lastActivityAt.getTime()).toBeGreaterThan(PAST.getTime());
      expect('fileCount' in stored!).toBe(false);
    });

    it('matches the stored casing from a differently-cased name', async () => {
      await seed('MixedCase', userId);

      await fileTagRepository.touchLastActivityBy({ name: 'mixedcase', userId });

      const stored = await tags().findOne({ name: 'MixedCase', userId });
      expect(stored!.lastActivityAt.getTime()).toBeGreaterThan(PAST.getTime());
    });

    it('does not mint a tag when none matches', async () => {
      await fileTagRepository.touchLastActivityBy({ name: 'never-existed', userId });

      expect(await tags().countDocuments({ userId })).toBe(0);
    });

    // Each arm used to be added to the filter only if truthy, so a blank one dropped out and left a
    // broader match. Both fixtures below are chosen to be exactly what the degraded filter would
    // have hit: drop the name and `{ userId }` alone sweeps up every tag this user owns; drop the
    // userId and `{ name }` alone reaches into another user's.
    it('refuses a blank name rather than touching every tag the user owns', async () => {
      await seed('invoices', userId);
      await seed('receipts', userId);

      await fileTagRepository.touchLastActivityBy({ name: '', userId });

      const touched = await tags().countDocuments({ userId, lastActivityAt: { $gt: PAST } });
      expect(touched).toBe(0);
    });

    it('refuses a blank userId rather than reaching into another user tag', async () => {
      await seed('invoices', 'someone-else');

      await fileTagRepository.touchLastActivityBy({ name: 'invoices', userId: '' });

      const other = await tags().findOne({ userId: 'someone-else' });
      expect(other!.lastActivityAt.getTime()).toBe(PAST.getTime());
    });

    it('leaves another user tag of the same name alone', async () => {
      await seed('invoices', userId);
      await seed('invoices', 'someone-else');

      await fileTagRepository.touchLastActivityBy({ name: 'invoices', userId });

      const other = await tags().findOne({ name: 'invoices', userId: 'someone-else' });
      expect(other!.lastActivityAt.getTime()).toBe(PAST.getTime());
    });
  });

  describe('findOrCreateByNameAndUserId', () => {
    it('inserts a new tag with no fileCount key', async () => {
      const created = await fileTagRepository.findOrCreateByNameAndUserId('receipts', userId, { color: '#fff' });

      expect(created).not.toBeNull();
      const stored = await tags().findOne({ name: 'receipts', userId });
      expect('fileCount' in stored!).toBe(false);
      expect(stored!.color).toBe('#fff');
    });

    it('touches the held tag instead of inserting a second one, preserving its insert data', async () => {
      await seed('receipts', userId, { color: '#original' });

      await fileTagRepository.findOrCreateByNameAndUserId('RECEIPTS', userId, { color: '#ignored' });

      expect(await tags().countDocuments({ userId })).toBe(1);
      const stored = await tags().findOne({ userId });
      expect(stored!.name).toBe('receipts');
      expect(stored!.color).toBe('#original');
      expect(stored!.createdAt.getTime()).toBe(PAST.getTime());
      expect(stored!.lastActivityAt.getTime()).toBeGreaterThan(PAST.getTime());
      expect('fileCount' in stored!).toBe(false);
    });

    // The duplicate-key retry is the concurrency loser's only chance to record the tag as used, so
    // it has to touch too. A real race is not reproducible on demand, so the first write is forced
    // to fail the way Mongo would and the retry then runs against the real database.
    it('still touches the tag on the duplicate-key retry path', async () => {
      await seed('shared', userId);
      const spy = vi.spyOn(fileTagModel(), 'findOneAndUpdate').mockImplementationOnce(() => {
        spy.mockRestore();
        return Promise.reject(Object.assign(new Error('duplicate key'), { code: 11000 })) as never;
      });

      const result = await fileTagRepository.findOrCreateByNameAndUserId('shared', userId, {});

      expect(result).not.toBeNull();
      const stored = await tags().findOne({ name: 'shared', userId });
      expect(stored!.lastActivityAt.getTime()).toBeGreaterThan(PAST.getTime());
      expect('fileCount' in stored!).toBe(false);
    });
  });

  // Removing the field from the schema does NOT stop an already-written one coming back out:
  // mongoose keeps a stored path it has no schema entry for and toJSON emits it. Nothing ships that
  // value to a client today - listFileTags spreads its own derived count last, and the tag write
  // routes return locally built objects - so this is why the $unset migration exists rather than a
  // live bug. Pinned because it is the non-obvious half: without the migration the dead number sits
  // there waiting for the next caller that forwards a raw tag document.
  it('still echoes a legacy stored fileCount until the migration unsets it', async () => {
    await seed('legacy', userId, { fileCount: 999 });

    const read = await fileTagRepository.findByFoldedNameAndUserId('legacy', userId);

    expect((read as unknown as { fileCount?: number }).fileCount).toBe(999);
  });
});
