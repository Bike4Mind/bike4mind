import { beforeEach, describe, it, expect } from 'vitest';
import type { RecordLakeFindingInput } from '@bike4mind/common';
import { dataLakeFindingRepository as repo, DataLakeFindingModel } from './DataLakeFindingModel';
import { setupMongoTest } from '../../__test__/utils';

const SEEN_FIRST = new Date('2026-09-01T00:00:00Z');
const SEEN_LATER = new Date('2026-09-08T00:00:00Z');

const input = (overrides: Partial<RecordLakeFindingInput> = {}): RecordLakeFindingInput => ({
  lakeId: 'lake-1',
  kind: 'metric-disagreement',
  subject: 'annual revenue usd',
  detector: 'lexical',
  sources: [
    { fabFileId: 'file-a', fileName: 'a.md', excerpt: 'revenue was 4M' },
    { fabFileId: 'file-b', fileName: 'b.md', excerpt: 'revenue was 7M' },
  ],
  documentCount: 2,
  seenAt: SEEN_FIRST,
  ...overrides,
});

describe('DataLakeFindingRepository', () => {
  setupMongoTest();

  // setupMongoTest drops the whole database between tests, and indexes go with it - so the identity
  // constraint has to be rebuilt per test rather than once in beforeAll, or every test after the
  // first would run without the constraint it is asserting on.
  beforeEach(async () => {
    await DataLakeFindingModel.ensureIndexes();
  });

  it('persists every field of a source, so the schema cannot silently drop one', async () => {
    // Mongoose strict mode drops anything declared on LakeFindingSource but not on the subschema,
    // and nothing else would go red - the write succeeds and the field is simply absent on read.
    const created = await repo.recordDetected(
      input({ sources: [{ fabFileId: 'file-a', fileName: null, excerpt: 'revenue was 4M' }] })
    );

    expect(created.sources).toEqual([{ fabFileId: 'file-a', fileName: null, excerpt: 'revenue was 4M' }]);
  });

  it('opens a finding on first detection, stamping both timestamps to the run', async () => {
    const created = await repo.recordDetected(input());

    expect(created.status).toBe('open');
    expect(created.firstSeenAt).toEqual(SEEN_FIRST);
    expect(created.lastSeenAt).toEqual(SEEN_FIRST);
    expect(created.assigneeUserId).toBeNull();
    expect(created.resolvedByUserId).toBeNull();
    expect(created.documentCount).toBe(2);
  });

  it('updates the existing row on re-detection rather than creating a duplicate', async () => {
    const first = await repo.recordDetected(input());
    const second = await repo.recordDetected(
      input({
        seenAt: SEEN_LATER,
        documentCount: 3,
        sources: [{ fabFileId: 'file-c', fileName: 'c.md', excerpt: 'revenue was 9M' }],
      })
    );

    expect(second.id).toBe(first.id);
    expect(await DataLakeFindingModel.countDocuments({})).toBe(1);
    // Observation refreshed...
    expect(second.lastSeenAt).toEqual(SEEN_LATER);
    expect(second.documentCount).toBe(3);
    expect(second.sources.map(s => s.fabFileId)).toEqual(['file-c']);
    // ...but the moment the problem was first seen is not rewritten by seeing it again.
    expect(second.firstSeenAt).toEqual(SEEN_FIRST);
  });

  it('keys on detector, so the reading pass does not collide with the pattern pass', async () => {
    await repo.recordDetected(input({ detector: 'lexical' }));
    await repo.recordDetected(input({ detector: 'model' }));

    // Same lake, kind and subject: these are two different passes reporting the same topic, and a
    // curator has to be able to tell a pattern hit from a model's reading of it.
    expect(await DataLakeFindingModel.countDocuments({})).toBe(2);
  });

  it('keeps one row per problem when two runs race the same new finding', async () => {
    // Fired together, not sequentially: a sequential pair would pass even without the unique index,
    // because the second upsert would simply find the first's row.
    const [a, b] = await Promise.all([repo.recordDetected(input()), repo.recordDetected(input())]);

    expect(await DataLakeFindingModel.countDocuments({})).toBe(1);
    expect(a.id).toBe(b.id);
  });

  it('never lets a re-detection overwrite a curator decision', async () => {
    const created = await repo.recordDetected(input());
    await repo.assignFinding(created.id, 'curator-1');
    await repo.resolveFinding(created.id, {
      status: 'resolved',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_FIRST,
      resolution: 'corrected the stale figure',
    });

    const recurred = await repo.recordDetected(input({ seenAt: SEEN_LATER }));

    // The problem came back. That is a fact about the corpus, not a reason to reopen the row under
    // the curator who closed it - so the decision stands and the recurrence shows as lastSeenAt
    // having moved past resolvedAt.
    expect(recurred.status).toBe('resolved');
    expect(recurred.resolvedByUserId).toBe('curator-1');
    expect(recurred.resolution).toBe('corrected the stale figure');
    expect(recurred.assigneeUserId).toBe('curator-1');
    expect(recurred.lastSeenAt).toEqual(SEEN_LATER);
    expect(recurred.lastSeenAt.getTime()).toBeGreaterThan(recurred.resolvedAt!.getTime());
  });

  it('resolves an open finding once, and refuses the second writer of a race', async () => {
    const created = await repo.recordDetected(input());
    const review = {
      status: 'dismissed' as const,
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_LATER,
      resolution: 'both figures are correct for different years',
    };

    const first = await repo.resolveFinding(created.id, review);
    const second = await repo.resolveFinding(created.id, { ...review, resolvedByUserId: 'curator-2' });

    expect(first?.status).toBe('dismissed');
    expect(first?.resolvedByUserId).toBe('curator-1');
    // Null, not a second write: the compare-and-set matched nothing because the row was no longer
    // open. Without it the later curator would silently overwrite the earlier one's ruling.
    expect(second).toBeNull();
  });

  it('assigns and unassigns in any status', async () => {
    const created = await repo.recordDetected(input());

    expect((await repo.assignFinding(created.id, 'curator-1'))?.assigneeUserId).toBe('curator-1');
    expect((await repo.assignFinding(created.id, null))?.assigneeUserId).toBeNull();
  });

  it('filters by status, kind and detector independently, most recently seen first', async () => {
    const open = await repo.recordDetected(input({ subject: 'open one', seenAt: SEEN_FIRST }));
    const dismissed = await repo.recordDetected(input({ subject: 'dismissed one', seenAt: SEEN_LATER }));
    await repo.recordDetected(input({ subject: 'other kind', kind: 'expired-claim', seenAt: SEEN_LATER }));
    await repo.recordDetected(input({ subject: 'other detector', detector: 'model', seenAt: SEEN_LATER }));
    await repo.resolveFinding(dismissed.id, {
      status: 'dismissed',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_LATER,
    });

    const all = await repo.listByLake('lake-1');
    expect(all).toHaveLength(4);
    // Most recently seen first, so a curator sees what is still happening before what is stale.
    expect(all[0].lastSeenAt).toEqual(SEEN_LATER);
    expect(all[all.length - 1].id).toBe(open.id);

    expect((await repo.listByLake('lake-1', { status: 'open' })).map(f => f.subject)).not.toContain('dismissed one');
    expect((await repo.listByLake('lake-1', { kind: 'expired-claim' })).map(f => f.subject)).toEqual(['other kind']);
    expect((await repo.listByLake('lake-1', { detector: 'model' })).map(f => f.subject)).toEqual(['other detector']);
    expect(await repo.listByLake('lake-1', { limit: 2 })).toHaveLength(2);
  });

  it('scopes every list to its own lake', async () => {
    await repo.recordDetected(input({ lakeId: 'lake-1' }));
    await repo.recordDetected(input({ lakeId: 'lake-2' }));

    expect(await repo.listByLake('lake-1')).toHaveLength(1);
  });

  it('sweeps every finding citing a purged document, across ALL lakes that held it', async () => {
    // The purge destroys the document globally, so a lake-scoped sweep would strand a 240-char
    // quote of it in every sibling lake that also held the file.
    await repo.recordDetected(input({ lakeId: 'lake-1', subject: 'cites the doomed file' }));
    await repo.recordDetected(input({ lakeId: 'lake-2', subject: 'also cites it' }));
    await repo.recordDetected(
      input({ lakeId: 'lake-1', subject: 'unrelated', sources: [{ fabFileId: 'file-z', fileName: 'z.md', excerpt: 'x' }] })
    );

    expect(await repo.deleteForPurgedDocument('file-a')).toBe(2);
    expect((await repo.listByLake('lake-1')).map(f => f.subject)).toEqual(['unrelated']);
    expect(await repo.listByLake('lake-2')).toHaveLength(0);
  });

  it('drops only the deleted lake findings', async () => {
    await repo.recordDetected(input({ lakeId: 'lake-1' }));
    await repo.recordDetected(input({ lakeId: 'lake-2' }));

    expect(await repo.deleteForLake('lake-1')).toBe(1);
    expect(await repo.listByLake('lake-1')).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });
});
