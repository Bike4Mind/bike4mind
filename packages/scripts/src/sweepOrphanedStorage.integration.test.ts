import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
} from '@aws-sdk/client-s3';
import { FabFile } from '@bike4mind/database';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import {
  assertBucketReachable,
  isNotFoundError,
  parseSweepArgs,
  s3SweepAdapters,
  sweepLegacyBackups,
  sweepOrphanedVersions,
  type ListedObject,
  type ObjectPresence,
} from './sweepOrphanedStorage';

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
  await mongoose.connection.dropDatabase();
});

const silent = () => undefined;

/** A file with v1 plus `edits` edited versions, current filePath = the newest. Soft-deleted by default. */
const seedFile = async (edits: number, over: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  const versions = Array.from({ length: edits + 1 }, (_, i) => ({
    version: i + 1,
    filePath: `files/u/${_id}/v${i + 1}`,
    fileSize: 10,
    mimeType: 'x',
    createdAt: new Date(0),
  }));
  const filePath = versions[versions.length - 1].filePath;
  await FabFile.collection.insertOne({
    _id,
    userId: 'u',
    fileName: 'report.docx',
    filePath,
    versions,
    deletedAt: new Date(0),
    ...over,
  });
  return { id: _id, filePath, keys: versions.map(v => v.filePath) };
};

/** HEAD answers from `presence` per key; absent by default. */
const fakeStorage = (presence: Record<string, ObjectPresence> = {}) => ({
  head: vi.fn(async (key: string) => presence[key] ?? 'absent'),
  delete: vi.fn().mockResolvedValue(undefined),
});

describe('sweepOrphanedVersions', () => {
  it('deletes the version keys of a soft-deleted row whose current file is gone, never filePath itself', async () => {
    const file = await seedFile(2);
    const storage = fakeStorage();

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.head).toHaveBeenCalledWith(file.filePath);
    expect(storage.delete.mock.calls.map(c => c[0]).sort()).toEqual(file.keys.slice(0, 2).sort());
    expect(storage.delete).not.toHaveBeenCalledWith(file.filePath);
    expect(result).toMatchObject({ rows: 1, keys: 2, bytes: 20, deleteFailures: 0 });
    // The row itself is untouched.
    expect((await FabFile.collection.findOne({ _id: file.id }))?.versions).toHaveLength(3);
  });

  it('skips a soft-deleted row whose filePath still exists (a restorable data-lake delete)', async () => {
    const file = await seedFile(2);
    const storage = fakeStorage({ [file.filePath]: 'present' });

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rows: 0, keys: 0, skippedPresent: 1 });
  });

  it('skips live rows, moderation evidence holds, and rows whose only version is the current file', async () => {
    await seedFile(2, { deletedAt: null });
    await seedFile(2, { moderationStatus: 'blocked', blockReason: 'csam' });
    await seedFile(0);
    const storage = fakeStorage();

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.head).not.toHaveBeenCalled();
    expect(result.rows).toBe(0);
  });

  it('sweeps an unsupported-format block, which deleteStoredObjects does not hold either', async () => {
    const file = await seedFile(1, { moderationStatus: 'blocked', blockReason: 'unsupported_format' });
    const storage = fakeStorage();

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.delete.mock.calls.map(c => c[0])).toEqual([file.keys[0]]);
    expect(result).toMatchObject({ rows: 1, keys: 1 });
  });

  it('skips a row with versions but no current filePath, without a HEAD', async () => {
    await seedFile(2, { filePath: undefined });
    const storage = fakeStorage();

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.head).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rows: 0, skippedNoFilePath: 1 });
  });

  it('skips a row when HEAD fails with anything other than NotFound', async () => {
    const file = await seedFile(2);
    const storage = fakeStorage({ [file.filePath]: 'error' });

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rows: 0, skippedHeadError: 1 });
  });

  it('never deletes a key a live row uses as its current file', async () => {
    const file = await seedFile(2);
    await FabFile.collection.insertOne({ userId: 'u', fileName: 'copy', filePath: file.keys[0], deletedAt: null });
    const storage = fakeStorage();

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(file.keys[1]);
    expect(result).toMatchObject({ keys: 1, skippedReferenced: 1 });
  });

  it('never deletes a key a soft-deleted, restorable row uses as its current file', async () => {
    const file = await seedFile(2);
    await FabFile.collection.insertOne({
      userId: 'u',
      fileName: 'lake',
      filePath: file.keys[1],
      deletedAt: new Date(0),
    });
    const storage = fakeStorage();

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.delete.mock.calls.map(c => c[0])).toEqual([file.keys[0]]);
    expect(result).toMatchObject({ keys: 1, skippedReferenced: 1 });
  });

  it('dry run deletes nothing but reports counts and bytes', async () => {
    await seedFile(3);
    const storage = fakeStorage();

    const result = await sweepOrphanedVersions({ dryRun: true, storage, log: silent });

    expect(storage.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rows: 1, keys: 3, bytes: 30 });
  });

  it('counts a failed delete instead of throwing, and keeps going', async () => {
    const a = await seedFile(1);
    const b = await seedFile(1);
    const storage = fakeStorage();
    storage.delete.mockImplementation(async (key: string) => {
      if (key === a.keys[0]) throw new Error('boom');
    });

    const result = await sweepOrphanedVersions({ dryRun: false, storage, log: silent });

    expect(storage.delete.mock.calls.map(c => c[0]).sort()).toEqual([a.keys[0], b.keys[0]].sort());
    expect(result).toMatchObject({ rows: 1, keys: 1, bytes: 10, deleteFailures: 1 });
  });
});

const NOW = new Date('2026-10-01T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

/**
 * A lister over a flat key list, filtering by prefix like S3 does. `stray` objects come back from
 * every listObjects call regardless of prefix, so the sweep's own key filter is what keeps them.
 */
const fakeLister = (objects: ListedObject[], stray: ListedObject[] = []) => ({
  async *listUserPrefixes() {
    const users = new Set(objects.map(o => o.key.split('/').slice(0, 2).join('/') + '/'));
    yield* [...users].filter(p => p.startsWith('files/'));
  },
  listObjects: vi.fn(async function* (prefix: string) {
    yield* objects.filter(o => o.key.startsWith(prefix));
    yield* stray;
  }),
});

describe('sweepLegacyBackups', () => {
  const objects: ListedObject[] = [
    { key: 'files/u1/backups/old_a.txt', size: 5, lastModified: daysAgo(90) },
    { key: 'files/u1/backups/young_b.txt', size: 5, lastModified: daysAgo(2) },
    { key: 'files/u1/report.docx', size: 99, lastModified: daysAgo(400) },
    { key: 'files/u2/backups/old_c.txt', size: 7, lastModified: daysAgo(31) },
  ];

  it('deletes only backups/ keys older than the cutoff', async () => {
    const lister = fakeLister(objects);
    const storage = fakeStorage();

    const result = await sweepLegacyBackups({
      dryRun: false,
      olderThanDays: 30,
      lister,
      storage,
      log: silent,
      now: NOW,
    });

    expect(storage.delete.mock.calls.map(c => c[0]).sort()).toEqual([
      'files/u1/backups/old_a.txt',
      'files/u2/backups/old_c.txt',
    ]);
    expect(lister.listObjects.mock.calls.map(c => c[0]).sort()).toEqual(['files/u1/backups/', 'files/u2/backups/']);
    expect(result).toMatchObject({ users: 2, keys: 2, bytes: 12, skippedYoung: 1, deleteFailures: 0 });
  });

  it('keeps a backups/ key that a live row serves as its current file', async () => {
    await FabFile.collection.insertOne({
      userId: 'u1',
      fileName: 'x',
      filePath: 'files/u1/backups/old_a.txt',
      deletedAt: null,
    });
    const storage = fakeStorage();

    const result = await sweepLegacyBackups({
      dryRun: false,
      olderThanDays: 30,
      lister: fakeLister(objects),
      storage,
      log: silent,
      now: NOW,
    });

    expect(storage.delete.mock.calls.map(c => c[0])).toEqual(['files/u2/backups/old_c.txt']);
    expect(result).toMatchObject({ keys: 1, skippedReferenced: 1 });
  });

  it('only deletes keys shaped like a legacy backup, and keeps one exactly at the cutoff', async () => {
    const stray: ListedObject[] = [
      { key: 'files/u1/backups/', size: 0, lastModified: daysAgo(90) },
      { key: 'files/u1/backups-old/x', size: 1, lastModified: daysAgo(90) },
      { key: 'files/u1/other/backups/x', size: 1, lastModified: daysAgo(90) },
    ];
    const atCutoff = { key: 'files/u3/backups/edge.txt', size: 3, lastModified: daysAgo(30) };
    const storage = fakeStorage();

    const result = await sweepLegacyBackups({
      dryRun: false,
      olderThanDays: 30,
      lister: fakeLister([objects[0], atCutoff], stray),
      storage,
      log: silent,
      now: NOW,
    });

    expect(storage.delete.mock.calls.map(c => c[0])).toEqual(['files/u1/backups/old_a.txt']);
    expect(result).toMatchObject({ keys: 1, skippedYoung: 1 });
  });

  it('checks references in chunks, so a user with thousands of backups is fully swept', async () => {
    const many = Array.from({ length: 2001 }, (_, i) => ({
      key: `files/u9/backups/b${i}.txt`,
      size: 1,
      lastModified: daysAgo(90),
    }));
    await FabFile.collection.insertOne({ userId: 'u9', fileName: 'x', filePath: many[2000].key, deletedAt: null });
    const storage = fakeStorage();

    const result = await sweepLegacyBackups({
      dryRun: true,
      olderThanDays: 30,
      lister: fakeLister(many),
      storage,
      log: silent,
      now: NOW,
    });

    expect(result).toMatchObject({ keys: 2000, skippedReferenced: 1 });
  });

  it('dry run deletes nothing; a delete failure is counted, not thrown', async () => {
    const storage = fakeStorage();
    const dry = await sweepLegacyBackups({
      dryRun: true,
      olderThanDays: 30,
      lister: fakeLister(objects),
      storage,
      log: silent,
      now: NOW,
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(dry).toMatchObject({ keys: 2, bytes: 12 });

    storage.delete.mockImplementation(async (key: string) => {
      if (key === 'files/u1/backups/old_a.txt') throw new Error('boom');
    });
    const applied = await sweepLegacyBackups({
      dryRun: false,
      olderThanDays: 30,
      lister: fakeLister(objects),
      storage,
      log: silent,
      now: NOW,
    });
    expect(storage.delete.mock.calls.map(c => c[0]).sort()).toEqual([
      'files/u1/backups/old_a.txt',
      'files/u2/backups/old_c.txt',
    ]);
    expect(applied).toMatchObject({ keys: 1, bytes: 7, deleteFailures: 1 });
  });
});

describe('parseSweepArgs', () => {
  it('runs both passes by default, dry run, 30 days', () => {
    expect(parseSweepArgs([])).toEqual({ apply: false, versions: true, backups: true, olderThanDays: 30 });
  });

  it('selects one pass and reads --older-than', () => {
    expect(parseSweepArgs(['--', '--backups', '--older-than', '7', '--apply'])).toEqual({
      apply: true,
      versions: false,
      backups: true,
      olderThanDays: 7,
    });
  });

  it.each([['--older-than', 'abc'], ['--older-than'], ['--older-than', '-1'], ['--aply']])(
    'rejects %s %s',
    (...argv) => {
      expect(() => parseSweepArgs(argv)).toThrow();
    }
  );
});

describe('isNotFoundError', () => {
  it('maps the SDK NotFound shapes, and nothing else', () => {
    expect(isNotFoundError({ name: 'NotFound' })).toBe(true);
    expect(isNotFoundError({ name: 'NoSuchKey' })).toBe(true);
    expect(
      isNotFoundError(Object.assign(new Error('x'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))
    ).toBe(true);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError('NotFound')).toBe(false);
    expect(isNotFoundError({ name: 'Unknown', $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isNotFoundError({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isNotFoundError(new Error('socket hang up'))).toBe(false);
  });
});

const sdkError = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

/** A real S3Client whose send is answered by `answer`; nothing reaches the network. */
const fakeS3 = (answer: (command: unknown) => unknown) => {
  const client = createS3Client({ region: 'us-east-1' });
  const send = vi.spyOn(client, 'send').mockImplementation(async (command: unknown) => answer(command));
  return { client, send };
};

describe('s3SweepAdapters', () => {
  it('HEAD maps only a definite NotFound to absent', async () => {
    const outcomes: Record<string, unknown> = {
      gone: sdkError('NotFound', 404),
      denied: sdkError('Forbidden', 403),
      flaky: new Error('socket hang up'),
    };
    const { client } = fakeS3(command => {
      const key = (command as HeadObjectCommand).input.Key ?? '';
      if (key in outcomes) throw outcomes[key];
      return {};
    });
    const { storage } = s3SweepAdapters(client, 'bkt');

    expect(await storage.head('here')).toBe('present');
    expect(await storage.head('gone')).toBe('absent');
    expect(await storage.head('denied')).toBe('error');
    expect(await storage.head('flaky')).toBe('error');
  });

  it('deletes one object from the configured bucket', async () => {
    const { client, send } = fakeS3(() => ({}));

    await s3SweepAdapters(client, 'bkt').storage.delete('files/u/k');

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect((command as DeleteObjectCommand).input).toEqual({ Bucket: 'bkt', Key: 'files/u/k' });
  });

  it('lists user prefixes by delimiter across pages, decoding url-encoded keys', async () => {
    const { client, send } = fakeS3(command => {
      const input = (command as ListObjectsV2Command).input;
      return input.ContinuationToken
        ? { CommonPrefixes: [{ Prefix: 'files/u%2B2+x/' }], IsTruncated: false }
        : { CommonPrefixes: [{ Prefix: 'files/u1/' }], IsTruncated: true, NextContinuationToken: 't1' };
    });

    const prefixes: string[] = [];
    for await (const p of s3SweepAdapters(client, 'bkt').lister.listUserPrefixes()) prefixes.push(p);

    expect(prefixes).toEqual(['files/u1/', 'files/u+2 x/']);
    const inputs = send.mock.calls.map(c => (c[0] as ListObjectsV2Command).input as ListObjectsV2CommandInput);
    expect(inputs).toEqual([
      { Bucket: 'bkt', Prefix: 'files/', Delimiter: '/', EncodingType: 'url', ContinuationToken: undefined },
      { Bucket: 'bkt', Prefix: 'files/', Delimiter: '/', EncodingType: 'url', ContinuationToken: 't1' },
    ]);
  });

  it('lists objects under a prefix across pages', async () => {
    const at = new Date(0);
    const { client } = fakeS3(command =>
      (command as ListObjectsV2Command).input.ContinuationToken
        ? { Contents: [{ Key: 'files/u1/backups/b%20c', Size: 2, LastModified: at }], IsTruncated: false }
        : {
            Contents: [{ Key: 'files/u1/backups/a', Size: 1, LastModified: at }],
            IsTruncated: true,
            NextContinuationToken: 't',
          }
    );

    const listed: ListedObject[] = [];
    for await (const o of s3SweepAdapters(client, 'bkt').lister.listObjects('files/u1/backups/')) listed.push(o);

    expect(listed).toEqual([
      { key: 'files/u1/backups/a', size: 1, lastModified: at },
      { key: 'files/u1/backups/b c', size: 2, lastModified: at },
    ]);
  });
});

describe('assertBucketReachable', () => {
  it('passes on a reachable bucket and refuses a missing one', async () => {
    const ok = fakeS3(() => ({}));
    await expect(assertBucketReachable(ok.client, 'bkt')).resolves.toBeUndefined();
    expect(ok.send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);

    const missing = fakeS3(() => {
      throw sdkError('NotFound', 404);
    });
    await expect(assertBucketReachable(missing.client, 'nope')).rejects.toThrow(/not reachable/);
  });
});
