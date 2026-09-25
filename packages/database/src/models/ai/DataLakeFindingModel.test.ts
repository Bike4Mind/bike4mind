import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { LakeFindingSource, RecordLakeFindingInput } from '@bike4mind/common';
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

/** Every field of LakeFindingSource. `keyof` makes the compiler reject this once the type gains one. */
const SOURCE_FIELDS: Record<keyof LakeFindingSource, true> = { fabFileId: true, fileName: true, excerpt: true };

describe('DataLakeFindingRepository', () => {
  setupMongoTest();

  // setupMongoTest drops the whole database between tests, and indexes go with it - so the identity
  // constraint has to be rebuilt per test rather than once in beforeAll, or every test after the
  // first would run without the constraint it is asserting on.
  beforeEach(async () => {
    await DataLakeFindingModel.ensureIndexes();
  });

  // Two tests below spy on `DataLakeFindingModel.findOneAndUpdate`. Restoring at the END of a test
  // body only runs when the body reaches it, so a failing assertion above would leak the spy into
  // every subsequent test in the file - one real failure reported as a cascade of unrelated ones.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('declares a source subschema field for field with LakeFindingSource', () => {
    // The parity guard the round-trip test below cannot be: that one names three fields literally,
    // so a FOURTH added to LakeFindingSource and forgotten here would not fail it - Mongoose strict
    // mode would just drop the field on write with nothing going red. Keyed off `keyof` so adding
    // to the interface breaks this object's type first, and the assertion second, forcing the
    // schema edit into the same commit.
    // Mongoose types `path()` as the base SchemaType, which carries no `schema` - narrowing to the
    // document-array shape is the only way to read a subschema's declared paths.
    const sources = DataLakeFindingModel.schema.path('sources') as unknown as {
      schema: { paths: Record<string, unknown> };
    };

    expect(Object.keys(sources.schema.paths).sort()).toEqual(Object.keys(SOURCE_FIELDS).sort());
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

  it('retries the loser of an insert race instead of surfacing its 11000', async () => {
    // The race test above only reaches the retry on an interleaving that actually collides, so it
    // passes whether or not the catch exists. Forcing the first call to reject with 11000 pins the
    // recovery itself: the retry must re-run the upsert and return the winner's row.
    const created = await repo.recordDetected(input());
    const collision = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    const spy = vi.spyOn(DataLakeFindingModel, 'findOneAndUpdate');
    spy.mockRejectedValueOnce(collision);

    const recovered = await repo.recordDetected(input({ seenAt: SEEN_LATER }));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(recovered.id).toBe(created.id);
    expect(recovered.lastSeenAt).toEqual(SEEN_LATER);
  });

  it('rethrows a non-11000 write error unchanged rather than retrying into it', async () => {
    // The bare code check is what keeps a real failure (a validation error, a dead connection) from
    // being retried once and then reported as whatever the second attempt happened to do.
    const failure = Object.assign(new Error('connection reset'), { code: 89 });
    const spy = vi.spyOn(DataLakeFindingModel, 'findOneAndUpdate');
    spy.mockRejectedValueOnce(failure);

    await expect(repo.recordDetected(input())).rejects.toThrow('connection reset');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never drags lastSeenAt backwards when two runs land out of order', async () => {
    // A retried queue message or a slow run finishing after a later one delivers an OLDER seenAt to
    // an existing row. A plain $set would move lastSeenAt back, which falsifies the two things the
    // field is read for - the lastSeenAt > resolvedAt recurrence signal and the queue's sort - and
    // can leave firstSeenAt after lastSeenAt.
    await repo.recordDetected(input({ seenAt: SEEN_LATER }));
    const stale = await repo.recordDetected(input({ seenAt: SEEN_FIRST }));

    expect(stale.lastSeenAt).toEqual(SEEN_LATER);
    expect(stale.firstSeenAt).toEqual(SEEN_LATER);
    expect(stale.lastSeenAt.getTime()).toBeGreaterThanOrEqual(stale.firstSeenAt.getTime());
  });

  it('never lets a re-detection overwrite a curator decision', async () => {
    const created = await repo.recordDetected(input());
    await repo.assignFinding('lake-1', created.id, 'curator-1');
    await repo.resolveFinding('lake-1', created.id, {
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

    const first = await repo.resolveFinding('lake-1', created.id, review);
    const second = await repo.resolveFinding('lake-1', created.id, { ...review, resolvedByUserId: 'curator-2' });

    expect(first?.status).toBe('dismissed');
    expect(first?.resolvedByUserId).toBe('curator-1');
    // Null, not a second write: the compare-and-set matched nothing because the row was no longer
    // open. Without it the later curator would silently overwrite the earlier one's ruling.
    expect(second).toBeNull();
  });

  it('assigns and unassigns in any status', async () => {
    const created = await repo.recordDetected(input());

    expect((await repo.assignFinding('lake-1', created.id, 'curator-1'))?.assigneeUserId).toBe('curator-1');
    expect((await repo.assignFinding('lake-1', created.id, null))?.assigneeUserId).toBeNull();
  });

  it('refuses both mutations when the lake does not own the row, whatever the id says', async () => {
    // `lakeId` is a FILTER term on both writes, so belongs-to-lake holds even for a caller that
    // never ran the route's check. Dropping it from either filter leaves the rule route-only and
    // this is the only thing that would notice.
    const created = await repo.recordDetected(input());

    expect(await repo.assignFinding('someone-elses-lake', created.id, 'curator-2')).toBeNull();
    expect(
      await repo.resolveFinding('someone-elses-lake', created.id, {
        status: 'dismissed',
        resolvedByUserId: 'curator-2',
        resolvedAt: SEEN_LATER,
      })
    ).toBeNull();

    // And the row is untouched - not merely "the call returned null".
    const untouched = await DataLakeFindingModel.findById(created.id);
    expect(untouched?.status).toBe('open');
    expect(untouched?.assigneeUserId).toBeNull();
  });

  it('filters by status, kind and detector independently, most recently seen first', async () => {
    const open = await repo.recordDetected(input({ subject: 'open one', seenAt: SEEN_FIRST }));
    const dismissed = await repo.recordDetected(input({ subject: 'dismissed one', seenAt: SEEN_LATER }));
    await repo.recordDetected(input({ subject: 'other kind', kind: 'expired-claim', seenAt: SEEN_LATER }));
    await repo.recordDetected(input({ subject: 'other detector', detector: 'model', seenAt: SEEN_LATER }));
    await repo.resolveFinding('lake-1', dismissed.id, {
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

  it('accepts a status array, matching any of them (GET /inconsistencies open+resolved)', async () => {
    const open = await repo.recordDetected(input({ subject: 'open one', seenAt: SEEN_FIRST }));
    const resolved = await repo.recordDetected(input({ subject: 'resolved one', seenAt: SEEN_LATER }));
    const dismissed = await repo.recordDetected(input({ subject: 'dismissed one', seenAt: SEEN_LATER }));
    await repo.resolveFinding('lake-1', resolved.id, {
      status: 'resolved',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_LATER,
    });
    await repo.resolveFinding('lake-1', dismissed.id, {
      status: 'dismissed',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_LATER,
    });

    const subjects = (await repo.listByLake('lake-1', { status: ['open', 'resolved'] })).map(f => f.subject);
    expect(subjects).toEqual(expect.arrayContaining([open.subject, resolved.subject]));
    expect(subjects).not.toContain(dismissed.subject);
  });

  it('narrows to the findings a run at or after seenSince still saw', async () => {
    // Nothing ever closes a finding the detector stops reporting - `status` is a curator's word, so
    // a detector retiring a row would be exactly the overwrite recordDetected refuses to make. The
    // row therefore stays open once the problem is fixed, which is right for a triage queue and
    // wrong for "what is wrong with my corpus NOW". This filter answers the second question without
    // mutating anything: GET /inconsistencies passes the last run's own date, so its findings can
    // never contradict the countsByKind stored beside them.
    await repo.recordDetected(input({ subject: 'stale problem', seenAt: SEEN_FIRST }));
    await repo.recordDetected(input({ subject: 'current problem', seenAt: SEEN_LATER }));

    const current = await repo.listByLake('lake-1', { seenSince: SEEN_LATER });
    expect(current.map(f => f.subject)).toEqual(['current problem']);

    // Inclusive: a run stamps its rows with the SAME instant it dates its summary, so an exclusive
    // bound would hide every finding the run just recorded.
    expect(await repo.listByLake('lake-1', { seenSince: SEEN_FIRST })).toHaveLength(2);
  });

  it('narrows to dismissals resolved at or after resolvedSince, unlike seenSince', async () => {
    // A subject dismissed BEFORE a run also gets its lastSeenAt bumped to that run's instant if the
    // detector re-reports it (recordDetected never touches status/resolvedAt on update) - so a
    // seenSince-scoped query for "what did this run dismiss" would also catch a dismissal that
    // predates the run entirely. resolvedAt is the only field that actually distinguishes the two.
    const preRun = await repo.recordDetected(input({ subject: 'dismissed before the run', seenAt: SEEN_FIRST }));
    await repo.resolveFinding('lake-1', preRun.id, {
      status: 'dismissed',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_FIRST,
    });
    // Re-detected by a later run: lastSeenAt advances even though status/resolvedAt do not.
    await repo.recordDetected(input({ subject: 'dismissed before the run', seenAt: SEEN_LATER }));

    const postRun = await repo.recordDetected(input({ subject: 'dismissed after the run', seenAt: SEEN_LATER }));
    await repo.resolveFinding('lake-1', postRun.id, {
      status: 'dismissed',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_LATER,
    });

    // seenSince alone cannot tell them apart: both rows now have lastSeenAt >= SEEN_LATER.
    const bySeenSince = (await repo.listByLake('lake-1', { status: 'dismissed', seenSince: SEEN_LATER })).map(
      f => f.subject
    );
    expect(bySeenSince).toEqual(expect.arrayContaining(['dismissed before the run', 'dismissed after the run']));
    expect(bySeenSince).toHaveLength(2);

    // resolvedSince keeps only the one actually dismissed at or after that instant.
    const byResolvedSince = await repo.listByLake('lake-1', { status: 'dismissed', resolvedSince: SEEN_LATER });
    expect(byResolvedSince.map(f => f.subject)).toEqual(['dismissed after the run']);
  });

  it('combines seenSince and resolvedSince to keep only rows this run counted and a later dismissal resolved', async () => {
    // resolvedSince alone also matches a row this run never re-detected (its lastSeenAt is from an
    // older run, so it never contributed to this run's countsByKind) - the compensation query in
    // GET /inconsistencies needs both terms together, not either alone.
    const stale = await repo.recordDetected(input({ subject: 'stale, not re-detected', seenAt: SEEN_FIRST }));
    await repo.resolveFinding('lake-1', stale.id, {
      status: 'dismissed',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_LATER,
    });

    const counted = await repo.recordDetected(input({ subject: 'counted, then dismissed', seenAt: SEEN_LATER }));
    await repo.resolveFinding('lake-1', counted.id, {
      status: 'dismissed',
      resolvedByUserId: 'curator-1',
      resolvedAt: SEEN_LATER,
    });

    const both = await repo.listByLake('lake-1', {
      status: 'dismissed',
      seenSince: SEEN_LATER,
      resolvedSince: SEEN_LATER,
    });
    expect(both.map(f => f.subject)).toEqual(['counted, then dismissed']);
  });

  it('pages with offset, breaking a lastSeenAt tie by id so no row is skipped or repeated', async () => {
    // Same seenAt on all four: findings from one detection run commonly land in the same instant,
    // and a page boundary that fell mid-tie is exactly the bug a `sort({ lastSeenAt: -1 })` alone
    // produces.
    for (const subject of ['a', 'b', 'c', 'd']) {
      await repo.recordDetected(input({ subject, seenAt: SEEN_FIRST }));
    }

    const firstPage = await repo.listByLake('lake-1', { limit: 2, offset: 0 });
    const secondPage = await repo.listByLake('lake-1', { limit: 2, offset: 2 });

    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(2);
    expect(new Set([...firstPage, ...secondPage].map(f => f.id)).size).toBe(4);
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
      input({
        lakeId: 'lake-1',
        subject: 'unrelated',
        sources: [{ fabFileId: 'file-z', fileName: 'z.md', excerpt: 'x' }],
      })
    );

    expect(await repo.deleteForPurgedDocument('file-a')).toBe(2);
    expect((await repo.listByLake('lake-1')).map(f => f.subject)).toEqual(['unrelated']);
    expect(await repo.listByLake('lake-2')).toHaveLength(0);
  });

  it('sweeps a batch of purged documents in one pass, across all lakes, and skips an empty list', async () => {
    // The teardown's form: one `$in` per chunk instead of one round trip per file. Same global
    // blast radius as the single-id method, and the same index serves it.
    await repo.recordDetected(input({ lakeId: 'lake-1', subject: 'cites file-a' }));
    await repo.recordDetected(input({ lakeId: 'lake-2', subject: 'also cites file-a' }));
    await repo.recordDetected(
      input({
        lakeId: 'lake-1',
        subject: 'cites file-z',
        sources: [{ fabFileId: 'file-z', fileName: 'z.md', excerpt: 'x' }],
      })
    );
    await repo.recordDetected(
      input({
        lakeId: 'lake-1',
        subject: 'survivor',
        sources: [{ fabFileId: 'file-keep', fileName: 'k.md', excerpt: 'x' }],
      })
    );

    // An empty list must not become a match-everything delete - the failure mode that would make
    // an empty chunk wipe the collection.
    expect(await repo.deleteForPurgedDocuments([])).toBe(0);
    expect(await DataLakeFindingModel.countDocuments({})).toBe(4);

    expect(await repo.deleteForPurgedDocuments(['file-a', 'file-z'])).toBe(3);
    expect((await repo.listByLake('lake-1')).map(f => f.subject)).toEqual(['survivor']);
    expect(await repo.listByLake('lake-2')).toHaveLength(0);
  });

  it('drops only the deleted lake findings', async () => {
    await repo.recordDetected(input({ lakeId: 'lake-1' }));
    await repo.recordDetected(input({ lakeId: 'lake-2' }));

    expect(await repo.deleteForLake('lake-1')).toBe(1);
    expect(await repo.listByLake('lake-1')).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });

  describe('listDismissedKeys (#3045)', () => {
    it('returns only the dismissed keys for that lake and detector', async () => {
      const dismiss = async (over: Partial<RecordLakeFindingInput>) => {
        const row = await repo.recordDetected(input(over));
        await repo.resolveFinding(row.lakeId, row.id, {
          status: 'dismissed',
          resolvedByUserId: 'u1',
          resolvedAt: SEEN_LATER,
        });
      };

      await dismiss({ subject: 'uptime' });
      await dismiss({ subject: 'other lake', lakeId: 'lake-2' });
      await dismiss({ subject: 'model detector', detector: 'model' });
      await repo.recordDetected(input({ subject: 'still open' }));
      const resolved = await repo.recordDetected(input({ subject: 'was resolved' }));
      await repo.resolveFinding(resolved.lakeId, resolved.id, {
        status: 'resolved',
        resolvedByUserId: 'u1',
        resolvedAt: SEEN_LATER,
      });

      const keys = await repo.listDismissedKeys('lake-1', 'lexical');

      // `resolved` is absent deliberately: that problem recurring is exactly what a curator has to
      // see, where a dismissed one recurring tells them nothing they did not already rule on.
      expect(keys).toEqual([{ kind: 'metric-disagreement', subject: 'uptime' }]);
    });

    it("returns the key halves alone, never the row's excerpts", async () => {
      const row = await repo.recordDetected(input());
      await repo.resolveFinding(row.lakeId, row.id, {
        status: 'dismissed',
        resolvedByUserId: 'u1',
        resolvedAt: SEEN_LATER,
      });

      const [key] = await repo.listDismissedKeys('lake-1', 'lexical');

      // This is read on every detection run, so carrying `sources` would pull each dismissed row's
      // document excerpts across purely to discard them.
      expect(Object.keys(key).sort()).toEqual(['kind', 'subject']);
    });

    it('is empty for a lake with nothing dismissed', async () => {
      await repo.recordDetected(input());

      expect(await repo.listDismissedKeys('lake-1', 'lexical')).toEqual([]);
    });
  });
});
