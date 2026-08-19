import { describe, expect, it, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument, IDataLakeProposalDocument } from '@bike4mind/common';
import { FabFileSourceType } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { approveDataLakeProposal, declineDataLakeProposal } from './reviewDataLakeProposal';

const OWNER = 'owner-1';

const ctx = (over: Partial<AccessContext> = {}): AccessContext =>
  ({ userId: OWNER, isAdmin: false, administeredOrgIds: [], ...over }) as AccessContext;

const lake = (over: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake-1',
    name: 'Lake',
    slug: 'lake',
    datalakeTag: 'datalake:lake-1',
    fileTagPrefix: 'lake:',
    createdByUserId: OWNER,
    status: 'active',
    ...over,
  }) as IDataLakeDocument;

const proposal = (over: Partial<IDataLakeProposalDocument> = {}): IDataLakeProposalDocument =>
  ({
    id: 'prop-1',
    dataLakeId: 'lake-1',
    status: 'pending',
    sourceUrl: 'https://example.com/report',
    canonicalSourceKey: 'https://example.com/report',
    title: 'Quarterly report',
    excerpt: 'a sample of the text',
    textHash: 'abc123',
    proposedTags: ['finance'],
    provenance: {
      producer: 'research_run',
      runId: 'run-7',
      query: 'quarterly filings',
      retrievedAt: new Date('2026-08-01T00:00:00Z'),
    },
    ...over,
  }) as IDataLakeProposalDocument;

const adapters = (
  over: {
    proposal?: IDataLakeProposalDocument | null;
    lake?: IDataLakeDocument | null;
    claimed?: IDataLakeProposalDocument | null;
    admitSource?: ReturnType<typeof vi.fn>;
  } = {}
) => {
  const found = over.proposal === undefined ? proposal() : over.proposal;
  const findById = vi.fn(async () => found);
  const claimForReview = vi.fn(async (_id: string, input: { status: string }) =>
    over.claimed === undefined
      ? ({ ...(found as IDataLakeProposalDocument), status: input.status } as IDataLakeProposalDocument)
      : over.claimed
  );
  const recordAdmission = vi.fn(async () => undefined);
  const releaseClaim = vi.fn(async () => undefined);
  const admitSource = over.admitSource ?? vi.fn(async () => ({ id: 'file-9', fileName: 'Quarterly report' }));
  return {
    deps: {
      db: {
        dataLakeProposals: { findById, claimForReview, recordAdmission, releaseClaim },
        dataLakes: { findById: vi.fn(async () => (over.lake === undefined ? lake() : over.lake)) },
      },
      admitSource,
    },
    findById,
    claimForReview,
    recordAdmission,
    releaseClaim,
    admitSource,
  };
};

describe('approveDataLakeProposal', () => {
  it('admits the source through the ordinary ingestion door and records the file', async () => {
    const { deps, admitSource, recordAdmission, claimForReview } = adapters();

    const result = await approveDataLakeProposal('prop-1', ctx(), deps);

    expect(admitSource).toHaveBeenCalledTimes(1);
    const [userId, params] = admitSource.mock.calls[0];
    expect(userId).toBe(OWNER);
    expect(params.url).toBe('https://example.com/report');
    expect(params.tags).toEqual([{ name: 'datalake:lake-1', strength: 1 }]);
    expect(recordAdmission).toHaveBeenCalledWith('prop-1', 'file-9');
    expect(claimForReview.mock.calls[0][1]).toMatchObject({ status: 'approved', reviewedByUserId: OWNER });
    expect(result.fabFile.id).toBe('file-9');
  });

  it('stamps run, source, retrieval time and approver onto the admitted file', async () => {
    const { deps, admitSource } = adapters();

    await approveDataLakeProposal('prop-1', ctx(), deps);

    const { provenance } = admitSource.mock.calls[0][1];
    expect(provenance.sourceType).toBe(FabFileSourceType.PROPOSAL_APPROVAL);
    expect(provenance.sourceMetadata).toMatchObject({
      proposalId: 'prop-1',
      sourceUrl: 'https://example.com/report',
      producer: 'research_run',
      runId: 'run-7',
      approvedByUserId: OWNER,
    });
    expect(provenance.sourceMetadata.retrievedAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(provenance.sourceMetadata.approvedAt).toBeInstanceOf(Date);
  });

  it('never stamps producer-proposed tags onto the file - they are advisory only', async () => {
    const { deps, admitSource } = adapters();

    await approveDataLakeProposal('prop-1', ctx(), deps);

    expect(admitSource.mock.calls[0][1].tags.map((t: { name: string }) => t.name)).toEqual(['datalake:lake-1']);
  });

  it('claims the proposal BEFORE admitting, so a double review cannot admit twice', async () => {
    const order: string[] = [];
    const admitSource = vi.fn(async () => {
      order.push('admit');
      return { id: 'file-9', fileName: 'f' };
    });
    const { deps, claimForReview } = adapters({ admitSource });
    claimForReview.mockImplementation(async (_id, input) => {
      order.push('claim');
      return { ...proposal(), status: input.status } as IDataLakeProposalDocument;
    });

    await approveDataLakeProposal('prop-1', ctx(), deps);

    expect(order).toEqual(['claim', 'admit']);
  });

  it('refuses a proposal another reviewer already ruled on, without admitting anything', async () => {
    const { deps, admitSource } = adapters({ claimed: null });

    await expect(approveDataLakeProposal('prop-1', ctx(), deps)).rejects.toThrow(BadRequestError);
    expect(admitSource).not.toHaveBeenCalled();
  });

  it('returns the proposal to the queue when admission fails, and rethrows', async () => {
    const admitSource = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const { deps, releaseClaim, recordAdmission } = adapters({ admitSource });

    await expect(approveDataLakeProposal('prop-1', ctx(), deps)).rejects.toThrow('fetch failed');
    expect(releaseClaim).toHaveBeenCalledWith('prop-1');
    expect(recordAdmission).not.toHaveBeenCalled();
  });

  it('404s an unknown proposal', async () => {
    const { deps } = adapters({ proposal: null });
    await expect(approveDataLakeProposal('nope', ctx(), deps)).rejects.toThrow(NotFoundError);
  });

  it('404s a proposal whose lake is gone', async () => {
    const { deps } = adapters({ lake: null });
    await expect(approveDataLakeProposal('prop-1', ctx(), deps)).rejects.toThrow(NotFoundError);
  });

  it('refuses a caller who cannot manage the lake, without admitting anything', async () => {
    const { deps, admitSource, claimForReview } = adapters();

    await expect(approveDataLakeProposal('prop-1', ctx({ userId: 'stranger' }), deps)).rejects.toThrow(BadRequestError);
    expect(claimForReview).not.toHaveBeenCalled();
    expect(admitSource).not.toHaveBeenCalled();
  });

  it('refuses to admit into a lake that cannot take writes', async () => {
    const { deps, admitSource } = adapters({ lake: lake({ status: 'archived' }) });

    await expect(approveDataLakeProposal('prop-1', ctx(), deps)).rejects.toThrow(BadRequestError);
    expect(admitSource).not.toHaveBeenCalled();
  });
});

describe('declineDataLakeProposal', () => {
  it('records the reason and the reviewer, and admits nothing', async () => {
    const { deps, claimForReview, admitSource } = adapters();

    const result = await declineDataLakeProposal('prop-1', ctx(), { reason: 'paywalled' }, deps);

    expect(claimForReview).toHaveBeenCalledWith(
      'prop-1',
      expect.objectContaining({
        status: 'declined',
        reviewedByUserId: OWNER,
        declineReason: 'paywalled',
      })
    );
    expect(admitSource).not.toHaveBeenCalled();
    expect(result.status).toBe('declined');
  });

  it('refuses a proposal already ruled on', async () => {
    const { deps } = adapters({ claimed: null });
    await expect(declineDataLakeProposal('prop-1', ctx(), {}, deps)).rejects.toThrow(BadRequestError);
  });

  it('refuses a caller who cannot manage the lake', async () => {
    const { deps, claimForReview } = adapters();

    await expect(declineDataLakeProposal('prop-1', ctx({ userId: 'stranger' }), {}, deps)).rejects.toThrow(
      BadRequestError
    );
    expect(claimForReview).not.toHaveBeenCalled();
  });

  it('can be declined even when the lake no longer takes writes', async () => {
    const { deps, claimForReview } = adapters({ lake: lake({ status: 'archived' }) });

    await declineDataLakeProposal('prop-1', ctx(), {}, deps);

    expect(claimForReview).toHaveBeenCalled();
  });
});
