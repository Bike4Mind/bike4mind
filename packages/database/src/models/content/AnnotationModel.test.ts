import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import {
  Annotation,
  annotationRepository,
  DELETED_AUTHOR_ANNOTATION_MARKER,
  DELETED_AUTHOR_ANNOTATION_TTL_SECONDS,
  hideDeletedAuthorAnnotations,
} from './AnnotationModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const comment = (publicId: string, authorId: string, over: Record<string, unknown> = {}) =>
  Annotation.create({ publicId, authorId, authorDisplayName: authorId, body: 'hi', ...over });

describe('hideDeletedAuthorAnnotations', () => {
  it("hides the author's annotations on every artifact from reads and counts, marked for expiry", async () => {
    await comment('pub-a', 'gone');
    await comment('pub-b', 'gone');
    await comment('pub-a', 'other');

    expect(await hideDeletedAuthorAnnotations('gone')).toBe(2);

    expect((await annotationRepository.findByArtifact('pub-a')).map(a => a.authorId)).toEqual(['other']);
    expect(await annotationRepository.countByArtifact('pub-b')).toBe(0);
    const hidden = await Annotation.find({ authorId: 'gone' }).lean();
    expect(hidden.every(a => a.deletedAt instanceof Date && a.deletedBy === DELETED_AUTHOR_ANNOTATION_MARKER)).toBe(
      true
    );
  });

  it('leaves annotations deleted earlier untouched, so they are not swept into the dustbin', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    await comment('pub-a', 'gone', { deletedAt: earlier, deletedBy: 'gone' });

    expect(await hideDeletedAuthorAnnotations('gone')).toBe(0);
    expect(await Annotation.findOne({ authorId: 'gone' }).lean()).toMatchObject({
      deletedAt: earlier,
      deletedBy: 'gone',
    });
  });

  it('is idempotent', async () => {
    await comment('pub-a', 'gone');
    await hideDeletedAuthorAnnotations('gone');

    expect(await hideDeletedAuthorAnnotations('gone')).toBe(0);
  });
});

describe('Annotation dustbin TTL index', () => {
  it('expires only marker-deleted rows, 90 days after deletedAt', async () => {
    await Annotation.syncIndexes();
    const ttl = (await Annotation.collection.indexes()).find(i => i.expireAfterSeconds !== undefined);

    expect(ttl).toMatchObject({
      key: { deletedAt: 1 },
      expireAfterSeconds: 90 * 24 * 60 * 60,
      partialFilterExpression: { deletedAt: { $type: 'date' }, deletedBy: DELETED_AUTHOR_ANNOTATION_MARKER },
    });
    expect(DELETED_AUTHOR_ANNOTATION_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
  });
});
