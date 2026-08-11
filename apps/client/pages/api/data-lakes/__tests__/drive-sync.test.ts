import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit-level test of the connect handler's gate + org-credential capture. The repository layer,
// AWS/SQS, auth gate, and crypto are mocked; the Drive folder-id validation runs for real.
const h = vi.hoisted(() => ({
  verifyOrgAccess: vi.fn(),
  decryptToken: vi.fn(),
  isEncrypted: vi.fn(),
  sendToQueue: vi.fn(),
  dlFindById: vi.fn(),
  userFindById: vi.fn(),
  connFindByDriveFolderId: vi.fn(),
  connCreate: vi.fn(),
  connUpdateCredential: vi.fn(),
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
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: h.decryptToken }));
vi.mock('@server/security/secretEncryption', () => ({ isEncrypted: h.isEncrypted }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('sst', () => ({ Resource: { driveLakeIngestQueue: { url: 'queue-url' } } }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    User: { findById: h.userFindById },
    orgGoogleDriveConnectionRepository: {
      ...actual.orgGoogleDriveConnectionRepository,
      findByDriveFolderId: h.connFindByDriveFolderId,
      create: h.connCreate,
      updateCredential: h.connUpdateCredential,
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
const makeReq = (body: Record<string, unknown>, user = { id: 'u1', isAdmin: false }) =>
  ({ method: 'POST', body, user }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('POST /api/data-lakes/drive-sync - org-owned connect (D1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA' });
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.userFindById.mockResolvedValue({ googleDrive: { refreshToken: 'enc-refresh' } });
    h.isEncrypted.mockReturnValue(true);
    h.decryptToken.mockReturnValue('plain-refresh');
    h.connFindByDriveFolderId.mockResolvedValue(null);
    h.connCreate.mockResolvedValue({ id: 'conn1' });
  });

  it('captures the org-owned credential on the connection and enqueues ingest', async () => {
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID, folderName: 'Docs' }), res);

    expect(h.connCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'orgA',
        authMode: 'oauth',
        driveFolderId: FOLDER_ID,
        targetDataLakeId: 'lake1',
        oauthRefreshToken: 'enc-refresh', // the encrypted value, copied verbatim
        connectedBy: 'u1',
      })
    );
    expect(h.sendToQueue).toHaveBeenCalledWith('queue-url', { connectionId: 'conn1' });
    expect(status).toHaveBeenCalledWith(202);
  });

  it('rejects when the connecting user has no Drive refresh token (must connect Drive first)', async () => {
    h.userFindById.mockResolvedValue({ googleDrive: null });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /connect your google drive/i
    );
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects an unreadable (undecryptable) credential rather than persisting a dead connection', async () => {
    h.decryptToken.mockImplementation(() => {
      throw new Error('bad key');
    });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/unreadable/i);
    expect(h.connCreate).not.toHaveBeenCalled();
  });

  it('gates on org owner/manager - a denied verifyOrgAccess stops the connect', async () => {
    h.verifyOrgAccess.mockRejectedValue(new Error('Organization not found'));
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /organization not found/i
    );
    expect(h.userFindById).not.toHaveBeenCalled(); // gate runs before credential capture
    expect(h.connCreate).not.toHaveBeenCalled();
  });

  it('rejects a personal (org-less) lake before touching auth or credentials', async () => {
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /organization-scoped/i
    );
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });

  it('404s an unknown lake', async () => {
    h.dlFindById.mockResolvedValue(null);
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'nope', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/not found/i);
  });

  it('409s when the folder is already claimed by a different lake', async () => {
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'other', targetDataLakeId: 'lakeOTHER' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);
    expect(status).toHaveBeenCalledWith(409);
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('409s when the lake is already connected to a different folder (E11000 on create)', async () => {
    // Second 409 branch: caught off an E11000 string match on the unique targetDataLakeId index -
    // easy to break, so it gets direct coverage.
    h.connCreate.mockRejectedValue(new Error('E11000 duplicate key error'));
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);
    expect(status).toHaveBeenCalledWith(409);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('reuses the same folder+lake connection and refreshes its stored credential', async () => {
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(h.connUpdateCredential).toHaveBeenCalledWith('conn1', 'orgA', 'enc-refresh');
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).toHaveBeenCalledWith('queue-url', { connectionId: 'conn1' });
    expect(status).toHaveBeenCalledWith(202);
  });

  it('rejects an invalid Drive folder id before any lookup', async () => {
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: 'bad id!' }), res)).rejects.toThrow(
      /valid drive folder id/i
    );
    expect(h.dlFindById).not.toHaveBeenCalled();
  });
});
