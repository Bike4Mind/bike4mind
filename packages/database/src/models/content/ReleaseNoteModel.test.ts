import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ReleaseNote, releaseNoteRepository, type GeneratedReleaseNote } from './ReleaseNoteModel';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await ReleaseNote.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await ReleaseNote.deleteMany({});
});

const deployedAt = new Date('2026-01-01T00:00:00Z');
const makeNote = (overrides: Partial<GeneratedReleaseNote> = {}): GeneratedReleaseNote => ({
  releaseTag: 'v1.2.3.4',
  deployedSha: 'abc123',
  deployedAt,
  headline: 'Faster search',
  summary: 'Search got quicker.',
  items: [{ category: 'improved', text: 'Search is faster', importance: 1, sourcePrs: [10] }],
  audience: 'public',
  status: 'scheduled',
  publishAt: new Date(deployedAt.getTime() + 12 * 3600_000),
  schemaVersion: 1,
  ...overrides,
});

describe('ReleaseNoteRepository.upsertGenerated', () => {
  it('inserts a new note with editedAt null', async () => {
    const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote());
    expect(preserved).toBe(false);
    expect(note.editedAt).toBeNull();
    expect(await ReleaseNote.countDocuments()).toBe(1);
  });

  it('overwrites an unedited note for the same tag', async () => {
    await releaseNoteRepository.upsertGenerated(makeNote());
    const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
    expect(preserved).toBe(false);
    expect(note.headline).toBe('Regenerated');
    expect(await ReleaseNote.countDocuments()).toBe(1);
  });

  it('preserves a human-edited note and returns it unchanged', async () => {
    await releaseNoteRepository.upsertGenerated(makeNote());
    const editedAt = new Date('2026-01-01T06:00:00Z');
    await ReleaseNote.updateOne({ releaseTag: 'v1.2.3.4' }, { $set: { headline: 'Hand edited', editedAt } });

    const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
    expect(preserved).toBe(true);
    expect(note.headline).toBe('Hand edited');
    expect(note.editedAt?.toISOString()).toBe(editedAt.toISOString());
    expect(await ReleaseNote.countDocuments()).toBe(1);
  });

  it('treats a duplicate key from a concurrent unedited insert as a race, not an edit', async () => {
    await ReleaseNote.create({ ...makeNote(), editedAt: null });
    const spy = vi
      .spyOn(ReleaseNote, 'findOneAndUpdate')
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    try {
      const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
      expect(preserved).toBe(false);
      expect(note.headline).toBe('Regenerated');
    } finally {
      spy.mockRestore();
    }
  });

  it('enforces one note per release tag', async () => {
    await ReleaseNote.create({ ...makeNote(), editedAt: null });
    await expect(ReleaseNote.create({ ...makeNote(), editedAt: null })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('ReleaseNoteRepository.findPublished', () => {
  it('returns a scheduled note only once its embargo has passed', async () => {
    const publishAt = new Date('2026-01-01T12:00:00Z');
    await releaseNoteRepository.upsertGenerated(makeNote({ publishAt }));

    expect(await releaseNoteRepository.findPublished(new Date(publishAt.getTime() - 1))).toHaveLength(0);
    expect(await releaseNoteRepository.findPublished(publishAt)).toHaveLength(1);
    expect(await releaseNoteRepository.findPublished(new Date(publishAt.getTime() + 1))).toHaveLength(1);
  });

  it('never returns hidden notes and sorts newest first', async () => {
    const now = new Date('2026-02-01T00:00:00Z');
    await releaseNoteRepository.upsertGenerated(makeNote({ releaseTag: 'v1', publishAt: new Date('2026-01-01') }));
    await releaseNoteRepository.upsertGenerated(makeNote({ releaseTag: 'v2', publishAt: new Date('2026-01-10') }));
    await releaseNoteRepository.upsertGenerated(
      makeNote({ releaseTag: 'v3', publishAt: new Date('2026-01-05'), status: 'hidden' })
    );

    const published = await releaseNoteRepository.findPublished(now);
    expect(published.map(n => n.releaseTag)).toEqual(['v2', 'v1']);
  });
});
