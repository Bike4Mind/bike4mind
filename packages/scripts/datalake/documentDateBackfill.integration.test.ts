import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { DocumentDateSource, FabFileSourceType } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import {
  checkOptions,
  exitCode,
  formatSummary,
  nextPageSize,
  runBackfill,
  toBackfillOptions,
  type BackfillDeps,
  type BackfillOptions,
  type DateExtractor,
} from './documentDateBackfill';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
  await fabFiles().deleteMany({});
});

function fabFiles() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection('fabfiles');
}

const PINNED_UPDATED_AT = new Date('2024-01-01T00:00:00Z');
const FRONTMATTER_DATE = new Date('2019-03-14T00:00:00Z');

/** What the fake extractor yields per stored path; the path doubles as the stored bytes. */
type Stored = { text?: string; date?: Date; missing?: 'NoSuchKey' | 'NotFound'; empty?: true; unreadable?: true };

const DATED_TEXT = 'dated body';
const UNDATED_TEXT = 'undated body';
const storedBytes: Record<string, Stored> = {
  'dated.md': { text: DATED_TEXT, date: FRONTMATTER_DATE },
  'undated.md': { text: UNDATED_TEXT },
  'textless.png': {},
  'gone.md': { missing: 'NoSuchKey' },
  'notfound.md': { missing: 'NotFound' },
  'empty.md': { empty: true },
  'broken.md': { unreadable: true },
};

const hashOf = (text: string) => dataLakeService.computeServerTextHash(text);

// Raw driver so a field can be genuinely ABSENT: that is the state the selection keys on, and a
// Mongoose create would fill defaults or bump timestamps.
async function seed(filePath: string | undefined, overrides: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId();
  const stored = filePath ? storedBytes[filePath] : undefined;
  await fabFiles().insertOne({
    _id,
    userId: 'user-1',
    fileName: filePath ?? 'pathless',
    mimeType: 'text/markdown',
    sourceType: FabFileSourceType.MANUAL_UPLOAD,
    deletedAt: null,
    chunked: true,
    isChunking: false,
    // A text-less chunk commit cuts no chunks, so it sums to 0.
    chunkedCharCount: stored?.text ? 10 : 0,
    serverTextHash: stored?.text ? hashOf(stored.text) : null,
    updatedAt: PINNED_UPDATED_AT,
    ...(filePath ? { filePath } : {}),
    ...overrides,
  });
  return _id;
}

async function load(id: mongoose.Types.ObjectId) {
  const doc = await fabFiles().findOne({ _id: id });
  if (!doc) throw new Error(`fabfile ${id} vanished`);
  return doc;
}

function makeDeps(onChunk?: (path: string) => Promise<void>) {
  let current: Stored = {};
  const chunker: DateExtractor = {
    async chunkFile(content) {
      const path = content.toString();
      current = storedBytes[path];
      await onChunk?.(path);
      return [];
    },
    getDocumentDate: () => (current.date ? { date: current.date, source: DocumentDateSource.FRONTMATTER } : undefined),
    getExtractedText: () => current.text,
  };
  const reads: string[] = [];
  const storage: BackfillDeps['storage'] = {
    async getContentAsBuffer(path: string) {
      reads.push(path);
      const stored = storedBytes[path];
      if (stored?.missing) throw Object.assign(new Error('gone'), { name: stored.missing });
      if (stored?.unreadable) throw new Error('decode failed');
      if (stored?.empty) return Buffer.alloc(0);
      return Buffer.from(path);
    },
  };
  return { deps: { chunker, storage, log: () => {} } satisfies BackfillDeps, reads };
}

const execute: BackfillOptions = { execute: true, batchSize: 100, fileIds: [], trustUnhashed: false };

describe('runBackfill (real DB)', () => {
  it('dates an eligible file and nulls an undated one, without bumping updatedAt', async () => {
    const dated = await seed('dated.md');
    const undated = await seed('undated.md');

    const result = await runBackfill(execute, makeDeps().deps);

    expect(result.counts).toMatchObject({ dated: 1, undated: 1, failed: 0 });
    expect(await load(dated)).toMatchObject({
      documentDate: FRONTMATTER_DATE,
      documentDateSource: DocumentDateSource.FRONTMATTER,
      updatedAt: PINNED_UPDATED_AT,
    });
    expect(await load(undated)).toMatchObject({ documentDate: null, documentDateSource: null });
    expect(exitCode(result)).toBe(0);
  });

  it('never selects an ineligible row, and never reads its bytes', async () => {
    const ineligible = [
      await seed('dated.md', { documentDate: null, documentDateSource: null }),
      await seed('dated.md', { chunkedCharCount: null }),
      await seed('dated.md', { deletedAt: new Date() }),
      await seed('dated.md', { chunked: false }),
      await seed('dated.md', { isChunking: true, chunkClaimedAt: new Date() }),
      await seed(undefined),
      await seed('', { filePath: '' }),
    ];

    const { deps, reads } = makeDeps();
    const result = await runBackfill(execute, deps);

    expect(Object.values(result.counts).every(count => count === 0)).toBe(true);
    expect(reads).toEqual([]);
    for (const id of ineligible) {
      const doc = await load(id);
      expect(doc.documentDate === null || !('documentDate' in doc)).toBe(true);
    }
  });

  it('selects a file whose last chunk run finished, even though its claim stamp outlives the run', async () => {
    const id = await seed('dated.md', { isChunking: false, chunkClaimedAt: new Date('2026-09-01T00:00:00Z') });
    const legacy = await seed('dated.md');
    await fabFiles().updateOne({ _id: legacy }, { $unset: { isChunking: '' } });

    const result = await runBackfill(execute, makeDeps().deps);

    expect(result.counts.dated).toBe(2);
    expect(await load(id)).toMatchObject({ documentDate: FRONTMATTER_DATE });
    expect(await load(legacy)).toMatchObject({ documentDate: FRONTMATTER_DATE });
  });

  it('nulls an unpinned Drive Editors file without downloading it', async () => {
    const id = await seed('dated.md', { sourceType: FabFileSourceType.GOOGLE_DRIVE });

    const { deps, reads } = makeDeps();
    const result = await runBackfill(execute, deps);

    expect(result.counts['editors-unrecoverable']).toBe(1);
    expect(reads).toEqual([]);
    expect(await load(id)).toMatchObject({ documentDate: null, documentDateSource: null });
  });

  it('leaves a row whose S3 object is gone or empty untouched and lists it without failing', async () => {
    const gone = await seed('gone.md');
    const notFound = await seed('notfound.md');
    const empty = await seed('empty.md');

    const result = await runBackfill(execute, makeDeps().deps);

    expect(result.counts['bytes-missing']).toBe(3);
    expect(result.missingBytes).toEqual([gone.toString(), notFound.toString(), empty.toString()]);
    for (const id of [gone, notFound, empty]) expect(await load(id)).not.toHaveProperty('documentDate');
    expect(exitCode(result)).toBe(0);
  });

  it('refuses to date bytes the served chunks were not cut from', async () => {
    // A rewrite nulled the hash, then backfill-chunk-char-length refilled chunkedCharCount from the
    // old chunks: the chunkedCharCount pre-filter passes, only the hash can tell.
    const rewritten = await seed('dated.md', { serverTextHash: null, chunkedCharCount: 42 });
    const hashMismatch = await seed('dated.md', { serverTextHash: hashOf('the text before the edit') });
    // The same tombstone, but the new bytes extract to no text: their null hash must not pass for it.
    const rewrittenTextless = await seed('textless.png', { serverTextHash: null, chunkedCharCount: 42 });

    const result = await runBackfill(execute, makeDeps().deps);

    expect(result.counts['stale-chunks']).toBe(3);
    expect(result.staleChunks).toEqual([rewritten.toString(), hashMismatch.toString(), rewrittenTextless.toString()]);
    expect(await load(rewrittenTextless)).not.toHaveProperty('documentDate');
    expect(await load(rewritten)).not.toHaveProperty('documentDate');
    expect(await load(hashMismatch)).not.toHaveProperty('documentDate');
    expect(formatSummary(result, true)).toContain(
      `Stale-chunk file ids: ${[rewritten, hashMismatch, rewrittenTextless].join(', ')}`
    );
  });

  it('trusts a null hash on a text-less file and an absent chunkedCharCount on a pre-rollup chunk pass', async () => {
    const textless = await seed('textless.png', { mimeType: 'image/png' });
    // Chunked before the rollups existed: an absent chunkedCharCount is not the rewrite's null.
    const preRollup = await seed('dated.md');
    await fabFiles().updateOne({ _id: preRollup }, { $unset: { chunkedCharCount: '' } });

    const result = await runBackfill(execute, makeDeps().deps);

    expect(result.counts).toMatchObject({ dated: 1, undated: 1, 'stale-chunks': 0 });
    expect(await load(textless)).toMatchObject({ documentDate: null });
    expect(await load(preRollup)).toMatchObject({ documentDate: FRONTMATTER_DATE });
  });

  describe('a file chunked before serverTextHash existed', () => {
    // Its chunkedCharCount may be a rollup refilled from chunks older than the stored bytes, and no
    // hash is there to catch it, so nothing on the row says whether the served chunks match.
    async function seedUnhashed(overrides: Record<string, unknown> = {}) {
      const id = await seed('dated.md', overrides);
      await fabFiles().updateOne({ _id: id }, { $unset: { serverTextHash: '' } });
      return id;
    }

    it('is not selected and only counted by default, without reading its bytes', async () => {
      const id = await seedUnhashed();

      const { deps, reads } = makeDeps();
      const result = await runBackfill(execute, deps);

      expect(result.unhashed).toBe(1);
      expect(result.counts.dated).toBe(0);
      expect(reads).toEqual([]);
      expect(await load(id)).not.toHaveProperty('documentDate');
      expect(formatSummary(result, true)[0]).toContain('1 not selected (chunked before serverTextHash');
    });

    it('does not consume the --limit budget ahead of files that can be dated', async () => {
      for (let i = 0; i < 3; i++) await seedUnhashed();
      const hashed = await seed('dated.md');

      const result = await runBackfill({ ...execute, limit: 2 }, makeDeps().deps);

      expect(result.unhashed).toBe(3);
      expect(result.counts.dated).toBe(1);
      expect(await load(hashed)).toMatchObject({ documentDate: FRONTMATTER_DATE });
    });

    it('still nulls an unpinned Drive Editors file, which needs no hash (in step with isUnpinnedDriveEditorsFile)', async () => {
      const editors = await Promise.all([
        seedUnhashed({ sourceType: FabFileSourceType.GOOGLE_DRIVE }),
        seedUnhashed({ sourceType: FabFileSourceType.GOOGLE_DRIVE, driveMd5Checksum: null }),
        seedUnhashed({ sourceType: FabFileSourceType.GOOGLE_DRIVE, driveMd5Checksum: '' }),
      ]);
      const nativeDrive = await seedUnhashed({ sourceType: FabFileSourceType.GOOGLE_DRIVE, driveMd5Checksum: 'md5' });

      const result = await runBackfill(execute, makeDeps().deps);

      expect(result.counts['editors-unrecoverable']).toBe(3);
      expect(result.unhashed).toBe(1);
      for (const id of editors) expect(await load(id)).toMatchObject({ documentDate: null, documentDateSource: null });
      expect(await load(nativeDrive)).not.toHaveProperty('documentDate');
    });

    it('is dated under --trust-unhashed, and reported as unverified', async () => {
      const id = await seedUnhashed();

      const result = await runBackfill({ ...execute, trustUnhashed: true }, makeDeps().deps);

      expect(result).toMatchObject({ unhashed: 0, unverified: 1, counts: { dated: 1 } });
      expect(await load(id)).toMatchObject({ documentDate: FRONTMATTER_DATE });
      expect(formatSummary(result, true)).toContain(
        '1 of those dated or nulled without verifying the served chunks (--trust-unhashed).'
      );
    });

    it('loses the race to a chunk commit that sets a hash between the read and the write', async () => {
      const id = await seedUnhashed();
      const { deps } = makeDeps(async () => {
        await fabFiles().updateOne({ _id: id }, { $set: { serverTextHash: hashOf('other') } });
      });

      const result = await runBackfill({ ...execute, trustUnhashed: true }, deps);

      expect(result.counts.raced).toBe(1);
      expect(result.unverified).toBe(0);
      expect(await load(id)).not.toHaveProperty('documentDate');
    });
  });

  it('loses the race to a re-chunk that lands between the read and the write', async () => {
    const id = await seed('dated.md');
    const reChunkedDate = new Date('2022-02-02T00:00:00Z');
    const { deps } = makeDeps(async () => {
      await fabFiles().updateOne(
        { _id: id },
        { $set: { documentDate: reChunkedDate, documentDateSource: DocumentDateSource.PDF_METADATA } }
      );
    });

    const result = await runBackfill(execute, deps);

    expect(result.counts.raced).toBe(1);
    expect(await load(id)).toMatchObject({ documentDate: reChunkedDate });
  });

  it.each([
    ['a chunk commit of different text', { serverTextHash: hashOf('the edited text') }],
    ['a content rewrite nulling the hash', { serverTextHash: null }],
    ['a re-chunk claim', { isChunking: true }],
  ])('loses the race to %s that lands between the read and the write', async (_label, patch) => {
    const id = await seed('dated.md');
    const { deps } = makeDeps(async () => {
      await fabFiles().updateOne({ _id: id }, { $set: patch });
    });

    const result = await runBackfill(execute, deps);

    expect(result.counts.raced).toBe(1);
    expect(await load(id)).not.toHaveProperty('documentDate');
  });

  it('does not mistake a hash removed between the read and the write for the null it read', async () => {
    const id = await seed('textless.png', { mimeType: 'image/png' });
    const { deps } = makeDeps(async () => {
      await fabFiles().updateOne({ _id: id }, { $unset: { serverTextHash: '' } });
    });

    const result = await runBackfill(execute, deps);

    expect(result.counts.raced).toBe(1);
    expect(await load(id)).not.toHaveProperty('documentDate');
  });

  it('counts a thrown file as failed, keeps going, and exits non-zero', async () => {
    const broken = await seed('broken.md');
    const dated = await seed('dated.md');

    const result = await runBackfill(execute, makeDeps().deps);

    expect(result.counts).toMatchObject({ failed: 1, dated: 1 });
    expect(result.failures).toEqual([broken.toString()]);
    expect(formatSummary(result, true)).toContain(`Failed file ids: ${broken.toString()}`);
    expect(await load(dated)).toMatchObject({ documentDate: FRONTMATTER_DATE });
    expect(exitCode(result)).toBe(1);
  });

  it('writes nothing on a dry run and reports the same counts', async () => {
    const id = await seed('dated.md');
    await seed('undated.md');

    const result = await runBackfill({ ...execute, execute: false }, makeDeps().deps);

    expect(result.counts).toMatchObject({ dated: 1, undated: 1 });
    expect(await load(id)).not.toHaveProperty('documentDate');
    expect(formatSummary(result, false)[0]).toMatch(/^Would write a date on 1 file\(s\) and null on 1/);
  });

  it('writes every page of a multi-page execute run and lists outcomes by id', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await seed('undated.md'));
    const gone = await seed('gone.md');

    const result = await runBackfill({ ...execute, batchSize: 2 }, makeDeps().deps);

    expect(result.counts).toMatchObject({ undated: 5, 'bytes-missing': 1 });
    for (const id of ids) expect(await load(id)).toMatchObject({ documentDate: null });
    const summary = formatSummary(result, true);
    expect(summary[0]).toMatch(/^Wrote a date on 0 file\(s\) and null on 5/);
    expect(summary).toContain(`Missing-bytes file ids: ${gone.toString()}`);
  });

  it('pages past batch boundaries, stops at --limit, and terminates a dry run', async () => {
    for (let i = 0; i < 5; i++) await seed('undated.md');

    const dryRun = { ...execute, execute: false, batchSize: 2 };
    const all = await runBackfill(dryRun, makeDeps().deps);
    const limited = await runBackfill({ ...dryRun, limit: 3 }, makeDeps().deps);

    expect(all.counts.undated).toBe(5);
    expect(all.resumeAfterId).toBeUndefined();
    expect(limited.counts.undated).toBe(3);
  });

  it('prints a cursor at --limit that continues past files skipped for a lasting reason', async () => {
    const gone = [await seed('gone.md'), await seed('gone.md')];
    const dated = await seed('dated.md');

    const first = await runBackfill({ ...execute, limit: 2 }, makeDeps().deps);
    expect(first.counts['bytes-missing']).toBe(2);
    expect(first.resumeAfterId).toBe(gone[1].toString());
    expect(formatSummary(first, true)).toContain(`Stopped at --limit; continue with --after-id ${gone[1]}`);

    const resumed = await runBackfill({ ...execute, limit: 2, afterId: first.resumeAfterId }, makeDeps().deps);
    expect(resumed.counts).toMatchObject({ dated: 1, 'bytes-missing': 0 });
    expect(await load(dated)).toMatchObject({ documentDate: FRONTMATTER_DATE });
  });

  it('restricts to --file-id', async () => {
    const picked = await seed('dated.md');
    const other = await seed('dated.md');

    await runBackfill({ ...execute, fileIds: [picked.toString()] }, makeDeps().deps);

    expect(await load(picked)).toMatchObject({ documentDate: FRONTMATTER_DATE });
    expect(await load(other)).not.toHaveProperty('documentDate');
  });

  it('pages through more --file-id ids than fit in one batch', async () => {
    const picked = [await seed('dated.md'), await seed('dated.md'), await seed('dated.md')];
    const other = await seed('dated.md');

    const result = await runBackfill(
      { ...execute, batchSize: 2, fileIds: picked.map(id => id.toString()) },
      makeDeps().deps
    );

    expect(result.counts.dated).toBe(3);
    expect(await load(other)).not.toHaveProperty('documentDate');
  });
});

describe('checkOptions', () => {
  const valid = { batchSize: 100, fileIds: [] };

  it('accepts sane options', () => {
    expect(checkOptions({ ...valid, limit: 5, fileIds: [new mongoose.Types.ObjectId().toString()] })).toBeUndefined();
  });

  it.each([
    ['a non-numeric --limit', { ...valid, limit: Number.NaN }, '--limit'],
    ['a fractional --limit', { ...valid, limit: 1.5 }, '--limit'],
    ['a zero --limit', { ...valid, limit: 0 }, '--limit'],
    ['a negative --limit', { ...valid, limit: -3 }, '--limit'],
    ['a zero --batch-size', { ...valid, batchSize: 0 }, '--batch-size'],
    ['a non-numeric --batch-size', { ...valid, batchSize: Number.NaN }, '--batch-size'],
    ['a non-ObjectId --file-id', { ...valid, fileIds: ['not-an-id'] }, 'not-an-id'],
    ['a non-ObjectId --after-id', { ...valid, afterId: 'nope' }, '--after-id'],
  ])('rejects %s', (_label, opts, expected) => {
    expect(checkOptions(opts)).toContain(expected);
  });
});

describe('toBackfillOptions', () => {
  it('binds every CLI flag to its option', () => {
    const fileId = new mongoose.Types.ObjectId().toString();
    const afterId = new mongoose.Types.ObjectId().toString();

    expect(
      toBackfillOptions({
        execute: true,
        'batch-size': 7,
        limit: 3,
        'file-id': [fileId],
        'after-id': afterId,
        'trust-unhashed': true,
      })
    ).toEqual({ execute: true, batchSize: 7, limit: 3, fileIds: [fileId], afterId, trustUnhashed: true });
  });
});

describe('nextPageSize', () => {
  it('uses the batch size when unbounded, and never overshoots --limit', () => {
    expect(nextPageSize({ batchSize: 100 }, 250)).toBe(100);
    expect(nextPageSize({ batchSize: 100, limit: 130 }, 100)).toBe(30);
  });
});
