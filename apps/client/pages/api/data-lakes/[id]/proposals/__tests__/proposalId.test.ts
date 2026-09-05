import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = { id: 'lake1', datalakeTag: 'datalake:lake1', createdByUserId: 'creator-1' };

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  approveDataLakeProposal: vi.fn(),
  declineDataLakeProposal: vi.fn(),
  findById: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'creator-1', isAdmin: false })),
  admitProposedSource: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    approveDataLakeProposal: h.approveDataLakeProposal,
    declineDataLakeProposal: h.declineDataLakeProposal,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeProposalRepository: { findById: h.findById },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/dataLakes/proposalAdmissionDeps', () => ({ admitProposedSource: h.admitProposedSource }));

import handler from '../[proposalId]';

const makeReq = (body: Record<string, unknown>) => ({
  method: 'POST',
  query: { id: 'lake1', proposalId: 'prop-1' },
  body,
  user: { id: 'creator-1' },
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(LAKE);
  h.findById.mockResolvedValue({ id: 'prop-1', dataLakeId: 'lake1' });
  h.approveDataLakeProposal.mockResolvedValue({
    proposal: { id: 'prop-1', status: 'approved' },
    fabFile: { id: 'file-9', fileName: 'Report' },
  });
  h.declineDataLakeProposal.mockResolvedValue({ id: 'prop-1', status: 'declined' });
});

describe('POST /api/data-lakes/:id/proposals/:proposalId', () => {
  it('approves through the service, wiring the ordinary ingestion door', async () => {
    const { res, json } = makeRes();

    await handler(makeReq({ decision: 'approve' }) as never, res);

    expect(h.approveDataLakeProposal).toHaveBeenCalledWith(
      'prop-1',
      expect.objectContaining({ userId: 'creator-1' }),
      expect.objectContaining({ admitSource: h.admitProposedSource })
    );
    expect(json).toHaveBeenCalledWith({
      data: { id: 'prop-1', status: 'approved' },
      fabFile: { id: 'file-9', fileName: 'Report' },
    });
  });

  it('declines with the reviewer reason and admits nothing', async () => {
    const { res, json } = makeRes();

    await handler(makeReq({ decision: 'decline', reason: 'paywalled' }) as never, res);

    expect(h.declineDataLakeProposal).toHaveBeenCalledWith(
      'prop-1',
      expect.objectContaining({ userId: 'creator-1' }),
      { reason: 'paywalled' },
      expect.anything()
    );
    expect(h.approveDataLakeProposal).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ data: { id: 'prop-1', status: 'declined' } });
  });

  it('404s a proposal that belongs to another lake, so managing one lake cannot rule on another', async () => {
    h.findById.mockResolvedValue({ id: 'prop-1', dataLakeId: 'lake-other' });
    const { res } = makeRes();

    await expect(handler(makeReq({ decision: 'approve' }) as never, res)).rejects.toThrow(/Proposal not found/);
    expect(h.approveDataLakeProposal).not.toHaveBeenCalled();
  });

  it('404s an unknown proposal', async () => {
    h.findById.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(handler(makeReq({ decision: 'approve' }) as never, res)).rejects.toThrow(/Proposal not found/);
  });

  it('rejects a decision the queue does not have - there is no auto-approve verb', async () => {
    const { res } = makeRes();

    await expect(handler(makeReq({ decision: 'auto_approve' }) as never, res)).rejects.toThrow();
    expect(h.approveDataLakeProposal).not.toHaveBeenCalled();
    expect(h.declineDataLakeProposal).not.toHaveBeenCalled();
  });
});
