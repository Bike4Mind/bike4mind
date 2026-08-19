import { describe, expect, it, vi } from 'vitest';
import type { IDataLakeProposalDocument } from '@bike4mind/common';
import { DATA_LAKE_PROPOSAL_EXCERPT_MAX_CHARS } from '@bike4mind/common';
import { computeServerTextHash } from './admissionContract';
import { proposeDataLakeContent, type ProposalCandidate } from './proposeDataLakeContent';

const LAKE = { id: 'lake-1', datalakeTag: 'datalake:lake-1' };

const candidate = (over: Partial<ProposalCandidate> = {}): ProposalCandidate => ({
  sourceUrl: 'https://example.com/report',
  title: 'Quarterly report',
  text: 'the candidate text',
  provenance: { producer: 'research_run', runId: 'run-1', retrievedAt: new Date('2026-08-01T00:00:00Z') },
  ...over,
});

const proposalRow = (over: Partial<IDataLakeProposalDocument> = {}): IDataLakeProposalDocument =>
  ({
    id: 'prop-1',
    dataLakeId: LAKE.id,
    status: 'pending',
    sourceUrl: 'https://example.com/report',
    canonicalSourceKey: 'https://example.com/report',
    title: 'Quarterly report',
    proposedTags: [],
    provenance: { producer: 'research_run', retrievedAt: new Date() },
    ...over,
  }) as IDataLakeProposalDocument;

const adapters = (over: { latest?: IDataLakeProposalDocument | null; lakeMembers?: unknown[] } = {}) => {
  const createProposal = vi.fn(async input => proposalRow(input as Partial<IDataLakeProposalDocument>));
  const findLatestBySourceKey = vi.fn(async () => over.latest ?? null);
  const findByServerTextHashesInDataLake = vi.fn(async () => (over.lakeMembers ?? []) as never);
  return {
    deps: {
      db: {
        dataLakeProposals: { findLatestBySourceKey, createProposal },
        fabFiles: { findByServerTextHashesInDataLake },
      },
    },
    createProposal,
    findLatestBySourceKey,
    findByServerTextHashesInDataLake,
  };
};

describe('proposeDataLakeContent', () => {
  it('creates a pending proposal for an unseen source', async () => {
    const { deps, createProposal } = adapters();

    const result = await proposeDataLakeContent(LAKE, candidate(), deps);

    expect(result.outcome).toBe('proposed');
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(createProposal.mock.calls[0][0]).toMatchObject({
      dataLakeId: 'lake-1',
      canonicalSourceKey: 'https://example.com/report',
      title: 'Quarterly report',
      textHash: computeServerTextHash('the candidate text'),
    });
  });

  it('hashes the candidate text itself rather than trusting a producer-supplied hash', async () => {
    const { deps, createProposal } = adapters();

    await proposeDataLakeContent(LAKE, candidate({ text: '  spaced   out\ntext  ' }), deps);

    // Normalized identically to the admission contract, so the two hashes are comparable.
    expect(createProposal.mock.calls[0][0].textHash).toBe(computeServerTextHash('spaced out text'));
  });

  it('dedupes on canonical source identity, not on the raw URL', async () => {
    const { deps, findLatestBySourceKey } = adapters();

    await proposeDataLakeContent(
      LAKE,
      candidate({ sourceUrl: 'HTTPS://Example.com/report?utm_source=news#top' }),
      deps
    );

    expect(findLatestBySourceKey).toHaveBeenCalledWith('lake-1', 'https://example.com/report');
  });

  it('truncates the excerpt and never stores the whole candidate', async () => {
    const { deps, createProposal } = adapters();
    const long = 'x'.repeat(DATA_LAKE_PROPOSAL_EXCERPT_MAX_CHARS + 500);

    await proposeDataLakeContent(LAKE, candidate({ text: long }), deps);

    expect(createProposal.mock.calls[0][0].excerpt).toHaveLength(DATA_LAKE_PROPOSAL_EXCERPT_MAX_CHARS);
    // The hash still covers the FULL text, so dedup is not weakened by the display truncation.
    expect(createProposal.mock.calls[0][0].textHash).toBe(computeServerTextHash(long));
  });

  it('refuses a source it cannot key, and proposes nothing', async () => {
    const { deps, createProposal, findLatestBySourceKey } = adapters();

    const result = await proposeDataLakeContent(LAKE, candidate({ sourceUrl: 'ftp://example.com/a' }), deps);

    expect(result).toEqual({ outcome: 'unusable_source', reason: 'not_http_url' });
    expect(findLatestBySourceKey).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('skips a source already awaiting review', async () => {
    const { deps, createProposal } = adapters({ latest: proposalRow({ status: 'pending', id: 'prop-9' }) });

    const result = await proposeDataLakeContent(LAKE, candidate(), deps);

    expect(result).toEqual({ outcome: 'duplicate_pending', proposalId: 'prop-9' });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('skips a source already approved whose text has not changed', async () => {
    const { deps, createProposal } = adapters({
      latest: proposalRow({ status: 'approved', textHash: computeServerTextHash('the candidate text') }),
    });

    const result = await proposeDataLakeContent(LAKE, candidate(), deps);

    expect(result).toMatchObject({ outcome: 'already_in_lake', reason: 'prior_approval' });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('re-proposes an approved source whose text changed materially', async () => {
    const { deps, createProposal } = adapters({
      latest: proposalRow({ status: 'approved', textHash: computeServerTextHash('the OLD text') }),
    });

    const result = await proposeDataLakeContent(LAKE, candidate(), deps);

    expect(result.outcome).toBe('proposed');
    expect(createProposal.mock.calls[0][0].priorDisposition).toBe('approved');
  });

  it('suppresses a tombstoned source whose text has not changed', async () => {
    const { deps, createProposal } = adapters({
      latest: proposalRow({
        status: 'declined',
        id: 'prop-dead',
        textHash: computeServerTextHash('the candidate text'),
      }),
    });

    const result = await proposeDataLakeContent(LAKE, candidate(), deps);

    expect(result).toEqual({ outcome: 'suppressed_by_tombstone', proposalId: 'prop-dead' });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('re-proposes a tombstoned source whose text changed materially, flagged as previously declined', async () => {
    const { deps, createProposal } = adapters({
      latest: proposalRow({ status: 'declined', textHash: computeServerTextHash('the OLD text') }),
    });

    const result = await proposeDataLakeContent(LAKE, candidate(), deps);

    expect(result.outcome).toBe('proposed');
    expect(createProposal.mock.calls[0][0].priorDisposition).toBe('declined');
  });

  it('does not re-propose a tombstoned source when either side has no hash to compare', async () => {
    const withoutStoredHash = adapters({ latest: proposalRow({ status: 'declined', textHash: null }) });
    expect((await proposeDataLakeContent(LAKE, candidate(), withoutStoredHash.deps)).outcome).toBe(
      'suppressed_by_tombstone'
    );

    const withoutCandidateHash = adapters({
      latest: proposalRow({ status: 'declined', textHash: computeServerTextHash('anything') }),
    });
    expect(
      (await proposeDataLakeContent(LAKE, candidate({ text: undefined }), withoutCandidateHash.deps)).outcome
    ).toBe('suppressed_by_tombstone');
  });

  it('skips a candidate whose text the lake already holds under a different source', async () => {
    const { deps, createProposal, findByServerTextHashesInDataLake } = adapters({
      lakeMembers: [{ id: 'file-1' }],
    });

    const result = await proposeDataLakeContent(LAKE, candidate(), deps);

    expect(findByServerTextHashesInDataLake).toHaveBeenCalledWith(
      [computeServerTextHash('the candidate text')],
      'datalake:lake-1'
    );
    expect(result).toMatchObject({ outcome: 'already_in_lake', reason: 'lake_member' });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('does not consult the lake by hash when the candidate has no text', async () => {
    const { deps, findByServerTextHashesInDataLake, createProposal } = adapters();

    const result = await proposeDataLakeContent(LAKE, candidate({ text: undefined }), deps);

    expect(findByServerTextHashesInDataLake).not.toHaveBeenCalled();
    expect(result.outcome).toBe('proposed');
    expect(createProposal.mock.calls[0][0].textHash).toBeUndefined();
  });

  it('records the source URL credential-stripped, keeping the reviewer-openable form', async () => {
    const { deps, createProposal } = adapters();

    await proposeDataLakeContent(
      LAKE,
      candidate({ sourceUrl: 'https://user:secret@example.com/report?utm_source=news' }),
      deps
    );

    expect(createProposal.mock.calls[0][0].sourceUrl).toBe('https://example.com/report?utm_source=news');
    expect(createProposal.mock.calls[0][0].canonicalSourceKey).toBe('https://example.com/report');
  });

  it('drops producer-proposed tags in the reserved data-lake namespace', async () => {
    const { deps, createProposal } = adapters();

    await proposeDataLakeContent(LAKE, candidate({ proposedTags: ['finance', 'DataLake:other-lake', 'q3'] }), deps);

    expect(createProposal.mock.calls[0][0].proposedTags).toEqual(['finance', 'q3']);
  });

  it('never carries a confidence score outside 0..1', async () => {
    const { deps, createProposal } = adapters();

    await proposeDataLakeContent(LAKE, candidate({ confidence: 7 }), deps);

    expect(createProposal.mock.calls[0][0].confidence).toBeUndefined();
  });
});
