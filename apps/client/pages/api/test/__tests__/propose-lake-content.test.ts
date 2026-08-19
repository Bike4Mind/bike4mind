import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = { id: 'lake-1', datalakeTag: 'datalake:lake-1' };

const h = vi.hoisted(() => ({
  isE2EEnabled: vi.fn(() => true),
  findById: vi.fn(),
  findBySlug: vi.fn(),
  proposeDataLakeContent: vi.fn(),
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
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@server/utils/config', () => ({ isE2EEnabled: h.isE2EEnabled }));
vi.mock('sst', () => ({ Resource: { E2E_CLEANUP_SECRET: { value: 'right-secret' } } }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findById: h.findById, findBySlug: h.findBySlug },
  dataLakeProposalRepository: {},
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { proposeDataLakeContent: h.proposeDataLakeContent },
}));

import handler from '../propose-lake-content';

const body = (over: Record<string, unknown> = {}) => ({
  dataLake: 'lake-1',
  sourceUrl: 'https://example.com/report',
  title: 'Quarterly report',
  ...over,
});

const makeReq = (over: { body?: Record<string, unknown>; secret?: string | undefined } = {}) => ({
  method: 'POST',
  query: {},
  body: over.body ?? body(),
  headers: 'secret' in over ? { 'x-e2e-cleanup-secret': over.secret } : { 'x-e2e-cleanup-secret': 'right-secret' },
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.isE2EEnabled.mockReturnValue(true);
  h.findById.mockResolvedValue(LAKE);
  h.findBySlug.mockResolvedValue(null);
  h.proposeDataLakeContent.mockResolvedValue({ outcome: 'proposed', proposal: { id: 'prop-1' } });
});

describe('POST /api/test/propose-lake-content', () => {
  it('refuses outright when E2E endpoints are disabled, whatever the secret', async () => {
    h.isE2EEnabled.mockReturnValue(false);
    const { res, status } = makeRes();

    await handler(makeReq() as never, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(h.proposeDataLakeContent).not.toHaveBeenCalled();
  });

  it('refuses a wrong or missing secret', async () => {
    const wrong = makeRes();
    await handler(makeReq({ secret: 'nope' }) as never, wrong.res);
    expect(wrong.status).toHaveBeenCalledWith(401);

    const missing = makeRes();
    await handler(makeReq({ secret: undefined }) as never, missing.res);
    expect(missing.status).toHaveBeenCalledWith(401);

    expect(h.proposeDataLakeContent).not.toHaveBeenCalled();
  });

  it('seeds through the REAL producer seam, not a direct write', async () => {
    const { res, status, json } = makeRes();

    await handler(makeReq() as never, res);

    expect(h.proposeDataLakeContent).toHaveBeenCalledTimes(1);
    const [lake, candidate] = h.proposeDataLakeContent.mock.calls[0];
    expect(lake).toBe(LAKE);
    expect(candidate).toMatchObject({ sourceUrl: 'https://example.com/report', title: 'Quarterly report' });
    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ outcome: 'proposed', proposal: { id: 'prop-1' } });
  });

  it('never forwards a caller-supplied hash - the service derives it from the text', async () => {
    const { res } = makeRes();

    await handler(makeReq({ body: body({ text: 'the text', textHash: 'forged-hash' }) }) as never, res);

    const [, candidate] = h.proposeDataLakeContent.mock.calls[0];
    expect(candidate.text).toBe('the text');
    expect(candidate).not.toHaveProperty('textHash');
  });

  it('returns the dedup outcome verbatim so a test can assert on it', async () => {
    h.proposeDataLakeContent.mockResolvedValue({ outcome: 'suppressed_by_tombstone', proposalId: 'prop-dead' });
    const { res, json } = makeRes();

    await handler(makeReq() as never, res);

    expect(json).toHaveBeenCalledWith({ outcome: 'suppressed_by_tombstone', proposalId: 'prop-dead' });
  });

  it('resolves the lake by slug when it is not an id', async () => {
    h.findById.mockResolvedValue(null);
    h.findBySlug.mockResolvedValue(LAKE);
    const { res, status } = makeRes();

    await handler(makeReq({ body: body({ dataLake: 'proposal-qa' }) }) as never, res);

    expect(h.findBySlug).toHaveBeenCalledWith('proposal-qa');
    expect(status).toHaveBeenCalledWith(201);
  });

  it('404s an unknown lake', async () => {
    h.findById.mockResolvedValue(null);
    const { res, status } = makeRes();

    await handler(makeReq() as never, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(h.proposeDataLakeContent).not.toHaveBeenCalled();
  });

  it('400s a body missing the required fields', async () => {
    const { res, status } = makeRes();

    await handler(makeReq({ body: { dataLake: 'lake-1' } }) as never, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(h.proposeDataLakeContent).not.toHaveBeenCalled();
  });

  it('labels a seeded proposal as e2e by default so it is identifiable in the queue', async () => {
    const { res } = makeRes();

    await handler(makeReq() as never, res);

    const [, candidate] = h.proposeDataLakeContent.mock.calls[0];
    expect(candidate.provenance.producer).toBe('e2e_seed');
    expect(candidate.provenance.retrievedAt).toBeInstanceOf(Date);
  });
});
