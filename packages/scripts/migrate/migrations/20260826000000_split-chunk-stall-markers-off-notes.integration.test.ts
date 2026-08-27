import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260826000000_split-chunk-stall-markers-off-notes';

const VECTORIZE_PAUSED_NOTE = 'Indexing paused by the data-lake convergence kill switch - reprocess to complete.';
const RECHUNK_PAUSED_NOTE =
  'Re-chunking paused by the data-lake convergence kill switch - its passages were removed and are ' +
  'rebuilt when convergence resumes.';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

function rawFabFiles() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection('fabfiles');
}

// Inserted with the raw driver so the row has none of the schema's new-field defaults - a faithful
// pre-migration document, which is the only shape this migration is allowed to depend on.
async function insertLegacyFile(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    userId: 'user-1',
    fileName: 'contract.pdf',
    status: 'complete',
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
  await rawFabFiles().insertOne(doc);
  return doc;
}

describe('split-chunk-stall-markers-off-notes migration (real DB)', () => {
  it('derives chunkStallReason from either kill-switch note and frees the field', async () => {
    const vectorize = await insertLegacyFile({ notes: VECTORIZE_PAUSED_NOTE });
    const rechunk = await insertLegacyFile({ notes: RECHUNK_PAUSED_NOTE });

    await migration.up();

    const a = await rawFabFiles().findOne({ _id: vectorize._id });
    expect(a?.chunkStallReason).toBe('vectorizePaused');
    expect('notes' in (a ?? {})).toBe(false);

    const b = await rawFabFiles().findOne({ _id: rechunk._id });
    expect(b?.chunkStallReason).toBe('rechunkPaused');
    expect('notes' in (b ?? {})).toBe(false);
  });

  it('derives noExtractableTextAt from updatedAt, for every wording of the old prefix', async () => {
    const withStamp = await insertLegacyFile({
      notes: 'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).',
    });
    const legacyWording = await insertLegacyFile({ notes: 'No extractable text: scanned image', updatedAt: undefined });

    await migration.up();

    const a = await rawFabFiles().findOne({ _id: withStamp._id });
    expect(a?.noExtractableTextAt).toEqual(new Date('2026-06-01T00:00:00Z'));
    expect('notes' in (a ?? {})).toBe(false);

    // No updatedAt to inherit, so it falls back to the migration's clock - the field is read as a
    // boolean, so any date is as correct as the row allows.
    const b = await rawFabFiles().findOne({ _id: legacyWording._id });
    expect(b?.noExtractableTextAt).toBeInstanceOf(Date);
  });

  it('leaves an owner-authored note completely alone', async () => {
    const owned = await insertLegacyFile({ notes: 'Signed copy - see clause 4 about the renewal window' });
    const mentionsThePhrase = await insertLegacyFile({
      notes: 'Scanner produced No extractable text last time, retry after OCR',
    });

    await migration.up();

    const a = await rawFabFiles().findOne({ _id: owned._id });
    expect(a?.notes).toBe('Signed copy - see clause 4 about the renewal window');
    expect(a?.chunkStallReason ?? null).toBeNull();
    expect(a?.noExtractableTextAt ?? null).toBeNull();

    // Anchored prefix: the phrase mid-note is the owner's text, not the pipeline's marker.
    const b = await rawFabFiles().findOne({ _id: mentionsThePhrase._id });
    expect(b?.notes).toBe('Scanner produced No extractable text last time, retry after OCR');
    expect(b?.noExtractableTextAt ?? null).toBeNull();
  });

  it('derives but never rewrites a note the owner appended to a marker', async () => {
    const appendedToStall = await insertLegacyFile({
      notes: `${VECTORIZE_PAUSED_NOTE}\n\nre-upload Monday`,
    });
    const appendedToZeroChunk = await insertLegacyFile({
      notes: 'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).\n\nsigned copy, clause 4',
    });

    await migration.up();

    // The marker still grades (no reader parses prose any more), and the owner's text survives.
    const a = await rawFabFiles().findOne({ _id: appendedToStall._id });
    expect(a?.chunkStallReason).toBe('vectorizePaused');
    expect(a?.notes).toBe(`${VECTORIZE_PAUSED_NOTE}\n\nre-upload Monday`);

    const b = await rawFabFiles().findOne({ _id: appendedToZeroChunk._id });
    expect(b?.noExtractableTextAt).toEqual(new Date('2026-06-01T00:00:00Z'));
    expect(b?.notes).toBe(
      'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).\n\nsigned copy, clause 4'
    );
  });

  it('is idempotent over the arms that keep their prose, too', async () => {
    const appended = await insertLegacyFile({ notes: `${RECHUNK_PAUSED_NOTE} - and mine` });

    await migration.up();
    const first = await rawFabFiles().findOne({ _id: appended._id });
    await migration.up();
    const second = await rawFabFiles().findOne({ _id: appended._id });

    expect(second).toEqual(first);
  });

  it('is idempotent - a second run changes nothing', async () => {
    const file = await insertLegacyFile({ notes: RECHUNK_PAUSED_NOTE });

    await migration.up();
    const first = await rawFabFiles().findOne({ _id: file._id });
    await migration.up();
    const second = await rawFabFiles().findOne({ _id: file._id });

    expect(second).toEqual(first);
  });

  it('down puts every marker back verbatim while notes is still free', async () => {
    const vectorize = await insertLegacyFile({ notes: VECTORIZE_PAUSED_NOTE });
    const rechunk = await insertLegacyFile({ notes: RECHUNK_PAUSED_NOTE });
    const zeroChunk = await insertLegacyFile({
      notes: 'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).',
    });

    await migration.up();
    await migration.down();

    expect((await rawFabFiles().findOne({ _id: vectorize._id }))?.notes).toBe(VECTORIZE_PAUSED_NOTE);
    expect((await rawFabFiles().findOne({ _id: rechunk._id }))?.notes).toBe(RECHUNK_PAUSED_NOTE);
    expect((await rawFabFiles().findOne({ _id: zeroChunk._id }))?.notes).toBe(
      'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).'
    );
    for (const { _id } of [vectorize, rechunk, zeroChunk]) {
      const row = await rawFabFiles().findOne({ _id });
      expect('chunkStallReason' in (row ?? {})).toBe(false);
      expect('noExtractableTextAt' in (row ?? {})).toBe(false);
    }
  });

  it('down restores the prose only where notes is free, and always drops the new fields', async () => {
    const stalled = await insertLegacyFile({ notes: VECTORIZE_PAUSED_NOTE });
    await migration.up();
    // The owner types a note after the split - reconstructing a marker over it is the exact harm the
    // migration exists to undo, so the rollback must not.
    await rawFabFiles().updateOne({ _id: stalled._id }, { $set: { notes: 'mine now' } });

    await migration.down();

    const row = await rawFabFiles().findOne({ _id: stalled._id });
    expect(row?.notes).toBe('mine now');
    expect('chunkStallReason' in (row ?? {})).toBe(false);
    expect('noExtractableTextAt' in (row ?? {})).toBe(false);
  });
});
