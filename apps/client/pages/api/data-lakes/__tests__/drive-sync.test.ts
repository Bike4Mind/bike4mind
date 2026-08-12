import { describe, it, expect, vi, beforeEach } from 'vitest';

// Both 409 branches here are real, easy-to-break branches (the second is caught off an E11000 string
// match), and assertLakeWriteAccess is the authorization gate for the whole connect flow - so they
// get direct coverage. Repo/service/AWS are mocked.
const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  toAccessContext: vi.fn(),
  findByDriveFolderId: vi.fn(),
  connCreate: vi.fn(),
  sendToQueue: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { assertLakeWriteAccess: h.assertLakeWriteAccess } }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/integrations/google/drive/driveClient', () => ({
  isValidDriveFolderId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('sst', () => ({ Resource: { driveLakeIngestQueue: { url: 'ingest-queue-url' } } }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository },
    orgGoogleDriveConnectionRepository: {
      ...actual.orgGoogleDriveConnectionRepository,
      findByDriveFolderId: h.findByDriveFolderId,
      create: h.connCreate,
    },
  };
});

import handler from '../drive-sync';

const FOLDER_ID = 'Folder_Abc-123';
const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};
const makeReq = (body: Record<string, unknown>) =>
  ({ method: 'POST', body, user: { id: 'u1', isAdmin: false } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('POST /api/data-lakes/drive-sync - connect + claim conflicts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeWriteAccess.mockResolvedValue({ id: 'lake1', organizationId: 'orgA' });
    h.findByDriveFolderId.mockResolvedValue(null);
    h.connCreate.mockResolvedValue({ id: 'conn1' });
  });

  it('creates the connection and enqueues ingest on the happy path', async () => {
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);
    expect(h.connCreate).toHaveBeenCalled();
    expect(h.sendToQueue).toHaveBeenCalledWith('ingest-queue-url', { connectionId: 'conn1' });
    expect(status).toHaveBeenCalledWith(202);
  });

  it('409s when the folder is already connected to a different lake', async () => {
    h.findByDriveFolderId.mockResolvedValue({ id: 'other', targetDataLakeId: 'lakeOTHER' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);
    expect(status).toHaveBeenCalledWith(409);
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('409s when the lake is already connected to a different folder (E11000 on create)', async () => {
    h.connCreate.mockRejectedValue(new Error('E11000 duplicate key error'));
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);
    expect(status).toHaveBeenCalledWith(409);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('reuses the connection (no new create) when the same folder+lake is re-synced', async () => {
    h.findByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).toHaveBeenCalledWith('ingest-queue-url', { connectionId: 'conn1' });
    expect(status).toHaveBeenCalledWith(202);
  });

  it('rejects when the write-access gate denies (authorization gate for the feature)', async () => {
    h.assertLakeWriteAccess.mockRejectedValue(new Error('Only the creator can add files to this data lake'));
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/creator/i);
    expect(h.connCreate).not.toHaveBeenCalled();
  });

  it('rejects a personal (org-less) lake before creating a connection', async () => {
    h.assertLakeWriteAccess.mockResolvedValue({ id: 'lake1', organizationId: undefined });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /organization-scoped/i
    );
    expect(h.connCreate).not.toHaveBeenCalled();
  });
});
