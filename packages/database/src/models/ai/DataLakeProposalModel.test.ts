import { describe, it, expect } from 'vitest';
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

describe('DataLakeProposalRepository', () => {
  setupMongoTest();

  it('creates every proposal pending, whatever a caller hoped for', async () => {
    const created = await repo.createProposal(input());

    expect(created.status).toBe('pending');
    expect(created.reviewedByUserId).toBeNull();
    expect(created.admittedFabFileId).toBeNull();
  });

  it('returns the LATEST row for a source, so an older ruling never decides', async () => {
    const first = await repo.createProposal(input());
    await repo.claimForReview(first.id, review({ status: 'declined', declineReason: 'paywalled' }));
    const second = await repo.createProposal(input({ textHash: 'hash-b' }));

    const latest = await repo.findLatestBySourceKey('lake-1', 'https://example.com/report');

    expect(latest?.id).toBe(second.id);
    expect(latest?.status).toBe('pending');
  });

  it('scopes the source lookup to one lake', async () => {
    await repo.createProposal(input());

    expect(await repo.findLatestBySourceKey('lake-2', 'https://example.com/report')).toBeNull();
  });

  it('claims a pending proposal exactly once - the second reviewer gets nothing', async () => {
    const created = await repo.createProposal(input());

    const first = await repo.claimForReview(created.id, review());
    const second = await repo.claimForReview(created.id, review({ reviewedByUserId: 'reviewer-2' }));

    expect(first?.status).toBe('approved');
    expect(first?.reviewedByUserId).toBe('reviewer-1');
    expect(second).toBeNull();
  });

  it('strips the declined material but keeps the tombstone and its fingerprint', async () => {
    const created = await repo.createProposal(input());

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
    const created = await repo.createProposal(input());

    const approved = await repo.claimForReview(created.id, review());

    expect(approved?.excerpt).toBe('a sample of the source text');
  });

  it('records the admitted file against the approval', async () => {
    const created = await repo.createProposal(input());
    await repo.claimForReview(created.id, review());

    await repo.recordAdmission(created.id, 'file-9');

    const stored = await DataLakeProposalModel.findById(created.id);
    expect(stored?.admittedFabFileId).toBe('file-9');
  });

  it('returns a claimed proposal to the queue with its reviewer stamp cleared', async () => {
    const created = await repo.createProposal(input());
    await repo.claimForReview(created.id, review());

    await repo.releaseClaim(created.id);

    const stored = await DataLakeProposalModel.findById(created.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.reviewedByUserId).toBeNull();
    expect(stored?.reviewedAt).toBeNull();
    // Claimable again - a failed admission must not strand the row.
    expect(await repo.claimForReview(created.id, review())).not.toBeNull();
  });

  it('lists a lake queue newest first, and narrows by status', async () => {
    const older = await repo.createProposal(input({ canonicalSourceKey: 'https://example.com/a' }));
    const newer = await repo.createProposal(input({ canonicalSourceKey: 'https://example.com/b' }));
    await repo.claimForReview(older.id, review({ status: 'declined' }));

    const all = await repo.listByLake('lake-1');
    const pending = await repo.listByLake('lake-1', { status: 'pending' });

    expect(all.map(p => p.id)).toEqual([newer.id, older.id]);
    expect(pending.map(p => p.id)).toEqual([newer.id]);
  });

  it('drops a deleted lake queue without touching another lake', async () => {
    await repo.createProposal(input());
    await repo.createProposal(input({ dataLakeId: 'lake-2' }));

    expect(await repo.deleteForLake('lake-1')).toBe(1);
    expect(await repo.listByLake('lake-1')).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });
});
