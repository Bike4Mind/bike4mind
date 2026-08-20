import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { CreateDataLakeProposalInput } from '@bike4mind/common';
import { dataLakeProposalRepository as repo, DataLakeProposalModel } from './DataLakeProposalModel';
import { setupMongoTest } from '../../__test__/utils';

const input = (overrides: Partial<CreateDataLakeProposalInput> = {}): CreateDataLakeProposalInput => ({
  dataLakeId: 'lake-1',
  sourceUrl: 'https://example.com/report',
  canonicalSourceKey: 'https://example.com/report',
  title: 'Quarterly report',
  excerpt: 'a sample of the source text',
  textHash: 'hash-a',
  proposedTags: ['finance'],
  confidence: 0.6,
  provenance: { producer: 'research_run', runId: 'run-1', retrievedAt: new Date('2026-08-01T00:00:00Z') },
  ...overrides,
});

const review = (overrides: Record<string, unknown> = {}) => ({
  status: 'approved' as const,
  reviewedByUserId: 'reviewer-1',
  reviewedAt: new Date('2026-08-02T00:00:00Z'),
  ...overrides,
});

/**
 * Unwraps the create result for the tests that only care about the row. Throws rather than returning
 * a union so a lost race in a test that did not intend one fails loudly at the call site.
 */
const create = async (overrides: Partial<CreateDataLakeProposalInput> = {}) => {
  const result = await repo.createProposal(input(overrides));
  if (!result.created) throw new Error(`expected a fresh row, lost the race to ${result.pendingProposalId}`);
  return result.proposal;
};

describe('DataLakeProposalRepository', () => {
  setupMongoTest();

  // setupMongoTest drops the whole database between tests, and indexes go with it - so the
  // pending-uniqueness constraint has to be rebuilt per test rather than once in beforeAll, or every
  // test after the first would run without the constraint it is asserting on.
  beforeEach(async () => {
    await DataLakeProposalModel.ensureIndexes();
  });

  it('creates every proposal pending, whatever a caller hoped for', async () => {
    const created = await create();

    expect(created.status).toBe('pending');
    expect(created.reviewedByUserId).toBeNull();
    expect(created.admittedFabFileId).toBeNull();
  });

  it('admits only ONE pending row per source per lake, so a concurrent run cannot double-enter', async () => {
    // Fired together, not sequentially: a sequential pair would pass even without the index, because
    // proposeDataLakeContent's preceding read would see the first row. The index is what holds when
    // two overlapping producer runs interleave their read and their write.
    const [first, second] = await Promise.all([repo.createProposal(input()), repo.createProposal(input())]);

    const created = [first, second].filter(r => r.created);
    const lost = [first, second].filter(r => !r.created);
    expect(created).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser is pointed at the winner, which is what lets the caller answer duplicate_pending.
    expect(lost[0]).toEqual({
      created: false,
      pendingProposalId: (created[0] as { proposal: { id: string } }).proposal.id,
    });
    expect(await repo.listByLake('lake-1', { status: 'pending' })).toHaveLength(1);
  });

  // The retry branch: the first insert collides, but by the time we look for the winner it has been
  // reviewed, so the pending slot is free and this candidate is an unanswered question again. The spy
  // only controls the INTERLEAVING - the collision and the retry both run against real Mongo.
  it('retries the insert when the colliding winner was reviewed in between', async () => {
    const winner = await create();
    const findOne = vi.spyOn(DataLakeProposalModel, 'findOne').mockImplementationOnce((async () => {
      // Stand in for "another reviewer ruled on it in that instant", which frees the partial index.
      await repo.claimForReview(winner.id, review());
      return null;
    }) as never);

    const retried = await repo.createProposal(input({ textHash: 'hash-b' }));

    expect(findOne).toHaveBeenCalledTimes(1);
    expect(retried.created).toBe(true);
    // Two rows for the source now: the approved winner and the freshly inserted candidate.
    expect(await repo.listByLake('lake-1')).toHaveLength(2);
    findOne.mockRestore();
  });

  it('surfaces a second collision rather than looping', async () => {
    await create();
    // Winner still pending on both attempts, but reported absent - so the retry collides too. A third
    // writer is a raw duplicate-key error by design, not an unbounded retry.
    const findOne = vi.spyOn(DataLakeProposalModel, 'findOne').mockResolvedValueOnce(null as never);

    await expect(repo.createProposal(input({ textHash: 'hash-b' }))).rejects.toMatchObject({ code: 11000 });

    findOne.mockRestore();
  });

  it('still allows a re-proposal once the prior row is terminal - the tombstone does not hold the key', async () => {
    const declined = await create();
    await repo.claimForReview(declined.id, review({ status: 'declined', declineReason: 'paywalled' }));

    // The whole point of the PARTIAL filter: a terminal row must not occupy the pending slot, or the
    // changed-text re-proposal rule could never fire.
    const reproposed = await repo.createProposal(input({ textHash: 'hash-b' }));

    expect(reproposed.created).toBe(true);
    expect(await repo.listByLake('lake-1')).toHaveLength(2);
  });

  it('lets the same source be pending in two different lakes at once', async () => {
    expect((await repo.createProposal(input())).created).toBe(true);
    expect((await repo.createProposal(input({ dataLakeId: 'lake-2' }))).created).toBe(true);
  });

  it('returns the LATEST row for a source, so an older ruling never decides', async () => {
    const first = await create();
    await repo.claimForReview(first.id, review({ status: 'declined', declineReason: 'paywalled' }));
    const second = await create({ textHash: 'hash-b' });

    const latest = await repo.findLatestBySourceKey('lake-1', 'https://example.com/report');

    expect(latest?.id).toBe(second.id);
    expect(latest?.status).toBe('pending');
  });

  it('scopes the source lookup to one lake', async () => {
    await create();

    expect(await repo.findLatestBySourceKey('lake-2', 'https://example.com/report')).toBeNull();
  });

  it('claims a pending proposal exactly once - the second reviewer gets nothing', async () => {
    const created = await create();

    const first = await repo.claimForReview(created.id, review());
    const second = await repo.claimForReview(created.id, review({ reviewedByUserId: 'reviewer-2' }));

    expect(first?.status).toBe('approved');
    expect(first?.reviewedByUserId).toBe('reviewer-1');
    expect(second).toBeNull();
  });

  it('strips the declined material but keeps the tombstone and its fingerprint', async () => {
    const created = await create();

    const declined = await repo.claimForReview(created.id, review({ status: 'declined', declineReason: 'paywalled' }));

    expect(declined?.excerpt).toBeNull();
    // The identity, the reason, the reviewer and the hash all survive - a hash is not the material,
    // and it is what detects this source coming back materially changed.
    expect(declined?.canonicalSourceKey).toBe('https://example.com/report');
    expect(declined?.declineReason).toBe('paywalled');
    expect(declined?.reviewedByUserId).toBe('reviewer-1');
    expect(declined?.textHash).toBe('hash-a');
  });

  it('keeps the excerpt on an approval - only a decline strips it', async () => {
    const created = await create();

    const approved = await repo.claimForReview(created.id, review());

    expect(approved?.excerpt).toBe('a sample of the source text');
  });

  it('records the admitted file against the approval', async () => {
    const created = await create();
    await repo.claimForReview(created.id, review());

    await repo.recordAdmission(created.id, 'file-9');

    const stored = await DataLakeProposalModel.findById(created.id);
    expect(stored?.admittedFabFileId).toBe('file-9');
  });

  it('returns a claimed proposal to the queue with its reviewer stamp cleared', async () => {
    const created = await create();
    await repo.claimForReview(created.id, review());

    await repo.releaseClaim(created.id);

    const stored = await DataLakeProposalModel.findById(created.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.reviewedByUserId).toBeNull();
    expect(stored?.reviewedAt).toBeNull();
    // Claimable again - a failed admission must not strand the row.
    expect(await repo.claimForReview(created.id, review())).not.toBeNull();
  });

  it('leaves a released claim alone when a fresh proposal already holds the pending slot', async () => {
    const approved = await create();
    await repo.claimForReview(approved.id, review());
    // The materially-changed re-proposal a producer can land while an approval is still admitting.
    const fresh = await create({ textHash: 'hash-b' });

    // Must not throw: releaseClaim runs inside approveDataLakeProposal's catch, where a duplicate-key
    // throw would mask the admission error that is the one worth reporting.
    await expect(repo.releaseClaim(approved.id)).resolves.toBeUndefined();

    const stored = await DataLakeProposalModel.findById(approved.id);
    expect(stored?.status).toBe('approved');
    expect((await repo.listByLake('lake-1', { status: 'pending' })).map(p => p.id)).toEqual([fresh.id]);
  });

  it('lists a lake queue newest first, and narrows by status', async () => {
    // Explicit, distinct createdAt values: two back-to-back inserts can land in the same millisecond,
    // which leaves `sort({ createdAt: -1 })` free to order them either way and the assertion below
    // flaky rather than wrong.
    const older = await create({ canonicalSourceKey: 'https://example.com/a' });
    const newer = await create({ canonicalSourceKey: 'https://example.com/b' });
    await DataLakeProposalModel.updateOne({ _id: older.id }, { $set: { createdAt: new Date('2026-08-01') } });
    await DataLakeProposalModel.updateOne({ _id: newer.id }, { $set: { createdAt: new Date('2026-08-02') } });
    await repo.claimForReview(older.id, review({ status: 'declined' }));

    const all = await repo.listByLake('lake-1');
    const pending = await repo.listByLake('lake-1', { status: 'pending' });

    expect(all.map(p => p.id)).toEqual([newer.id, older.id]);
    expect(pending.map(p => p.id)).toEqual([newer.id]);
  });

  it('drops a deleted lake queue without touching another lake', async () => {
    await create();
    await create({ dataLakeId: 'lake-2' });

    expect(await repo.deleteForLake('lake-1')).toBe(1);
    expect(await repo.listByLake('lake-1')).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });
});
