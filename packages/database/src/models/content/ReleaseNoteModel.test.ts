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

  it('keeps a stored video when an unedited note is regenerated', async () => {
    await releaseNoteRepository.upsertGenerated(makeNote());
    const video = { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' };
    await ReleaseNote.updateOne({ releaseTag: 'v1.2.3.4' }, { $set: { video } });

    const { note } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
    expect(note.headline).toBe('Regenerated');
    expect(note.video?.landscapeUrl).toBe(video.landscapeUrl);
  });

  it('keeps the video of an edited note across regeneration', async () => {
    await releaseNoteRepository.upsertGenerated(makeNote());
    const { note: stored } = await releaseNoteRepository.upsertGenerated(makeNote());
    await releaseNoteRepository.edit(stored.id, { video: { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' } });

    const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
    expect(preserved).toBe(true);
    expect(note.video?.landscapeUrl).toBe('https://d111.cloudfront.net/wide.mp4');
    expect(note.editedAt).not.toBeNull();
  });

  it('sets editedAt when a video is attached and cleared', async () => {
    const { note: stored } = await releaseNoteRepository.upsertGenerated(makeNote());
    const set = await releaseNoteRepository.edit(stored.id, {
      video: { portraitUrl: 'https://d111.cloudfront.net/t.mp4' },
    });
    expect(set.kind === 'ok' && set.note.editedAt).toBeInstanceOf(Date);

    const cleared = await releaseNoteRepository.edit(stored.id, { video: null });
    expect(cleared.kind === 'ok' && cleared.note.video).toBeNull();
  });

  it('attachVideo sets the video without marking the note edited, so it still regenerates', async () => {
    const { note: stored } = await releaseNoteRepository.upsertGenerated(makeNote());
    const video = { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' };
    const attached = await releaseNoteRepository.attachVideo(stored.id, video);
    expect(attached.kind === 'ok' && attached.note.editedAt).toBeNull();
    expect(attached.kind === 'ok' && attached.note.video?.landscapeUrl).toBe(video.landscapeUrl);

    const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
    expect(preserved).toBe(false);
    expect(note.headline).toBe('Regenerated');
    expect(note.video?.landscapeUrl).toBe(video.landscapeUrl);
  });

  it('attachVideo reports notFound for a missing note', async () => {
    const result = await releaseNoteRepository.attachVideo(new mongoose.Types.ObjectId().toString(), null);
    expect(result.kind).toBe('notFound');
  });

  it('attachImage sets the image without marking the note edited, so it still regenerates', async () => {
    const { note: stored } = await releaseNoteRepository.upsertGenerated(makeNote());
    const image = {
      landscapeUrl: 'https://d111.cloudfront.net/still.png',
      portraitUrl: 'https://d111.cloudfront.net/still-9x16.png',
    };
    const attached = await releaseNoteRepository.attachImage(stored.id, image);
    expect(attached.kind).toBe('ok');
    expect(attached.kind === 'ok' && attached.note.image).toMatchObject(image);
    expect(attached.kind === 'ok' && attached.note.editedAt).toBeNull();

    const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
    expect(preserved).toBe(false);
    expect(note.image).toMatchObject(image);
  });

  it('attachImage reports notFound for a missing note', async () => {
    const result = await releaseNoteRepository.attachImage(new mongoose.Types.ObjectId().toString(), null);
    expect(result.kind).toBe('notFound');
  });

  it('sets editedAt when an admin edit clears the image', async () => {
    const { note: stored } = await releaseNoteRepository.upsertGenerated(makeNote());
    await releaseNoteRepository.attachImage(stored.id, { landscapeUrl: 'https://d111.cloudfront.net/still.png' });
    const cleared = await releaseNoteRepository.edit(stored.id, { image: null });
    expect(cleared.kind === 'ok' && cleared.note.image).toBeNull();
    expect(cleared.kind === 'ok' && cleared.note.editedAt).toBeInstanceOf(Date);
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

describe('ReleaseNoteRepository.findPublishedById', () => {
  it('finds a note only while the feed would list it', async () => {
    const publishAt = new Date('2026-01-01T12:00:00Z');
    const { note } = await releaseNoteRepository.upsertGenerated(makeNote({ publishAt }));

    expect(await releaseNoteRepository.findPublishedById(note.id, new Date(publishAt.getTime() - 1))).toBeNull();
    expect((await releaseNoteRepository.findPublishedById(note.id, publishAt))?.id).toBe(note.id);

    await releaseNoteRepository.hide(note.id);
    expect(await releaseNoteRepository.findPublishedById(note.id, publishAt)).toBeNull();
  });

  it('returns null for an id that is not an ObjectId', async () => {
    expect(await releaseNoteRepository.findPublishedById('not-an-id', new Date())).toBeNull();
  });
});

describe('ReleaseNoteRepository.findPublishedBetween', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-07T23:59:59.999Z');

  it('returns published notes inside the inclusive range, newest first', async () => {
    await releaseNoteRepository.upsertGenerated(
      makeNote({ releaseTag: 'before', publishAt: new Date(start.getTime() - 1) })
    );
    await releaseNoteRepository.upsertGenerated(makeNote({ releaseTag: 'first', publishAt: start }));
    await releaseNoteRepository.upsertGenerated(makeNote({ releaseTag: 'last', publishAt: end }));
    await releaseNoteRepository.upsertGenerated(
      makeNote({ releaseTag: 'after', publishAt: new Date(end.getTime() + 1) })
    );
    await releaseNoteRepository.upsertGenerated(
      makeNote({ releaseTag: 'hidden', publishAt: new Date('2026-01-03T00:00:00Z'), status: 'hidden' })
    );

    const notes = await releaseNoteRepository.findPublishedBetween(start, end, new Date('2026-02-01T00:00:00Z'), 50);
    expect(notes.map(n => n.releaseTag)).toEqual(['last', 'first']);
  });

  it('leaves out a note still under embargo at `now` even when it falls inside the range', async () => {
    const now = new Date('2026-01-05T00:00:00Z');
    await releaseNoteRepository.upsertGenerated(makeNote({ releaseTag: 'live', publishAt: new Date('2026-01-04') }));
    await releaseNoteRepository.upsertGenerated(
      makeNote({ releaseTag: 'embargoed', publishAt: new Date('2026-01-06') })
    );

    const notes = await releaseNoteRepository.findPublishedBetween(start, end, now, 50);
    expect(notes.map(n => n.releaseTag)).toEqual(['live']);
  });

  it('caps the result at `limit`', async () => {
    for (const day of [2, 3, 4]) {
      await releaseNoteRepository.upsertGenerated(
        makeNote({ releaseTag: `v${day}`, publishAt: new Date(`2026-01-0${day}T00:00:00Z`) })
      );
    }

    const notes = await releaseNoteRepository.findPublishedBetween(start, end, end, 2);
    expect(notes.map(n => n.releaseTag)).toEqual(['v4', 'v3']);
  });
});

const HOUR = 3600_000;
const NOW = new Date('2026-03-01T00:00:00Z');
const seed = (tag: string, publishAt: Date, overrides: Partial<GeneratedReleaseNote> = {}) =>
  ReleaseNote.create({ ...makeNote({ releaseTag: tag, publishAt, ...overrides }), editedAt: null });

describe('ReleaseNoteRepository.listPublished', () => {
  it('pages every published note exactly once across publishAt ties', async () => {
    const tied = new Date(NOW.getTime() - 50 * HOUR);
    for (let i = 0; i < 25; i++) {
      await seed(`v${i}`, i < 3 ? tied : new Date(NOW.getTime() - (i + 1) * HOUR));
    }
    await seed('future', new Date(NOW.getTime() + HOUR));
    await seed('hidden', new Date(NOW.getTime() - HOUR), { status: 'hidden' });

    const seen: string[] = [];
    let after: { publishAt: Date; id: string } | undefined;
    let pages = 0;
    for (;;) {
      const { items, hasMore } = await releaseNoteRepository.listPublished({ now: NOW, after, limit: 10 });
      pages++;
      seen.push(...items.map(n => n.releaseTag));
      if (!hasMore) break;
      const last = items[items.length - 1];
      after = { publishAt: last.publishAt, id: last.id };
    }

    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).not.toContain('future');
    expect(seen).not.toContain('hidden');
  });
});

describe('ReleaseNoteRepository.adminList', () => {
  it('splits notes into scheduled, published and hidden at `now`', async () => {
    await seed('live', new Date(NOW.getTime() - HOUR));
    await seed('pending', new Date(NOW.getTime() + HOUR));
    await seed('gone', new Date(NOW.getTime() - HOUR), { status: 'hidden' });

    const tags = async (status: 'scheduled' | 'hidden' | 'published') =>
      (await releaseNoteRepository.adminList({ status, now: NOW, limit: 10 })).items.map(n => n.releaseTag);
    expect(await tags('published')).toEqual(['live']);
    expect(await tags('scheduled')).toEqual(['pending']);
    expect(await tags('hidden')).toEqual(['gone']);
  });
});

describe('ReleaseNoteRepository admin mutations', () => {
  it('edit edits copy and stamps editedAt', async () => {
    const note = await seed('v1', NOW);
    const result = await releaseNoteRepository.edit(note.id, { headline: 'Edited' });
    expect(result.kind).toBe('ok');
    const stored = await ReleaseNote.findById(note.id);
    expect(stored?.headline).toBe('Edited');
    expect(stored?.editedAt).toBeInstanceOf(Date);
  });

  it('edit refuses to empty the items of a scheduled note but allows it on a hidden one', async () => {
    const scheduled = await seed('v1', NOW);
    const hidden = await seed('v2', NOW, { status: 'hidden' });
    expect(await releaseNoteRepository.edit(scheduled.id, { items: [] })).toEqual({ kind: 'emptyItems' });
    expect((await ReleaseNote.findById(scheduled.id))?.items).toHaveLength(1);
    expect((await releaseNoteRepository.edit(hidden.id, { items: [] })).kind).toBe('ok');
  });

  it('reports notFound for an unknown id', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    expect(await releaseNoteRepository.edit(id, { headline: 'x' })).toEqual({ kind: 'notFound' });
    expect(await releaseNoteRepository.hide(id)).toEqual({ kind: 'notFound' });
    expect(await releaseNoteRepository.unhide(id)).toEqual({ kind: 'notFound' });
    expect(await releaseNoteRepository.publishNow(id)).toEqual({ kind: 'notFound' });
  });

  it('unhide and publishNow refuse a note with no items', async () => {
    const note = await seed('v1', NOW, { status: 'hidden', items: [] });
    expect(await releaseNoteRepository.unhide(note.id)).toEqual({ kind: 'emptyItems' });
    expect(await releaseNoteRepository.publishNow(note.id)).toEqual({ kind: 'emptyItems' });
    expect((await ReleaseNote.findById(note.id))?.status).toBe('hidden');
  });

  it('unhide restores scheduled with the original publishAt', async () => {
    const publishAt = new Date(NOW.getTime() + HOUR);
    const note = await seed('v1', publishAt, { status: 'hidden' });
    const result = await releaseNoteRepository.unhide(note.id, NOW);
    expect(result.kind === 'ok' && result.note.status).toBe('scheduled');
    expect(result.kind === 'ok' && result.note.publishAt.toISOString()).toBe(publishAt.toISOString());
  });

  it('unhide moves a note whose publishAt passed while hidden to now', async () => {
    const note = await seed('v1', new Date(NOW.getTime() - 5 * HOUR), { status: 'hidden' });
    const result = await releaseNoteRepository.unhide(note.id, NOW);
    expect(result.kind === 'ok' && result.note.publishAt.toISOString()).toBe(NOW.toISOString());
  });

  it('unhide on an already-live note keeps its publishAt', async () => {
    const publishAt = new Date(NOW.getTime() - 5 * HOUR);
    const note = await seed('v1', publishAt);
    const result = await releaseNoteRepository.unhide(note.id, NOW);
    expect(result.kind === 'ok' && result.note.publishAt.toISOString()).toBe(publishAt.toISOString());
  });

  it('publishNow moves a hidden note with a past publishAt to now', async () => {
    const note = await seed('v1', new Date(NOW.getTime() - 5 * HOUR), { status: 'hidden' });
    const result = await releaseNoteRepository.publishNow(note.id, NOW);
    expect(result.kind === 'ok' && result.note.status).toBe('scheduled');
    expect(result.kind === 'ok' && result.note.publishAt.toISOString()).toBe(NOW.toISOString());
  });

  it('publishNow pulls a scheduled note forward to now', async () => {
    const note = await seed('v1', new Date(NOW.getTime() + 5 * HOUR));
    const result = await releaseNoteRepository.publishNow(note.id, NOW);
    expect(result.kind === 'ok' && result.note.publishAt.toISOString()).toBe(NOW.toISOString());
    expect((await releaseNoteRepository.listPublished({ now: NOW, limit: 10 })).items).toHaveLength(1);
  });

  it('publishNow never moves an already-live note later', async () => {
    const publishAt = new Date(NOW.getTime() - 5 * HOUR);
    const note = await seed('v1', publishAt);
    for (let i = 0; i < 2; i++) {
      const result = await releaseNoteRepository.publishNow(note.id, NOW);
      expect(result.kind === 'ok' && result.note.publishAt.toISOString()).toBe(publishAt.toISOString());
    }
  });

  it('a hidden note stays hidden when its tag is regenerated', async () => {
    await releaseNoteRepository.upsertGenerated(makeNote());
    const stored = await ReleaseNote.findOne({ releaseTag: 'v1.2.3.4' });
    await releaseNoteRepository.hide(stored!.id);

    const { note, preserved } = await releaseNoteRepository.upsertGenerated(makeNote({ headline: 'Regenerated' }));
    expect(preserved).toBe(true);
    expect(note.status).toBe('hidden');
    expect(note.headline).toBe('Faster search');
  });
});
