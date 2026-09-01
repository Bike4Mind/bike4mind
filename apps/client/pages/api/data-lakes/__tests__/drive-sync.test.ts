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
  connRelease: vi.fn(),
  getValidUserDriveAccessToken: vi.fn(),
  createDriveClient: vi.fn(),
  getFolderAccess: vi.fn(),
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
vi.mock('@server/integrations/google/drive/common', () => ({
  getValidUserDriveAccessToken: h.getValidUserDriveAccessToken,
}));
// Keep isValidDriveFolderId real (the folder-id validation runs for real); mock only the Drive calls.
vi.mock('@server/integrations/google/drive/driveClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/google/drive/driveClient')>();
  return { ...actual, createDriveClient: h.createDriveClient, getFolderAccess: h.getFolderAccess };
});
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
      release: h.connRelease,
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
  ({ method: 'POST', body, user, logger: { error: vi.fn() } }) as never;
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
    h.connUpdateCredential.mockResolvedValue({ id: 'conn1' });
    h.connRelease.mockResolvedValue(true);
    h.getValidUserDriveAccessToken.mockResolvedValue('user-access-token');
    h.createDriveClient.mockReturnValue({});
    h.getFolderAccess.mockResolvedValue({ exists: true, isFolder: true, canRead: true });
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
    // The gate is checked against the LAKE's org, never a caller-supplied one.
    expect(h.verifyOrgAccess).toHaveBeenCalledWith(expect.anything(), 'orgA');
  });

  it('refuses to claim a folder the connecting user cannot read (anti-squat gate)', async () => {
    // Drive 404s a folder the caller can't see, so getFolderAccess reports it as non-existent - the
    // claim must be refused so a manager can't squat a folder id belonging to another org.
    h.getFolderAccess.mockResolvedValue({ exists: false, isFolder: false, canRead: false });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /do not have access/i
    );
    expect(h.connFindByDriveFolderId).not.toHaveBeenCalled();
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a readable id that is a file, not a folder', async () => {
    h.getFolderAccess.mockResolvedValue({ exists: true, isFolder: false, canRead: true });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/not a folder/i);
    expect(h.connCreate).not.toHaveBeenCalled();
  });

  it('rejects a credential that is not stored encrypted (never persists a plaintext token)', async () => {
    h.isEncrypted.mockReturnValue(false);
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /not stored securely/i
    );
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
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

  it('reuses the same folder+lake connection, refreshes its credential, and re-stamps connectedBy', async () => {
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    // connectedBy is re-stamped to the re-syncing caller so ingest never runs as a deleted user.
    expect(h.connUpdateCredential).toHaveBeenCalledWith('conn1', 'orgA', 'enc-refresh', 'u1');
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).toHaveBeenCalledWith('queue-url', { connectionId: 'conn1' });
    expect(status).toHaveBeenCalledWith(202);
  });

  it('409s (not a false 202) when the reuse-branch credential update matches nothing', async () => {
    // updateCredential is org-scoped; a null return means the folder's connection belongs to another
    // org. The route must not report success for a write that changed nothing.
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    h.connUpdateCredential.mockResolvedValue(null);
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(status).toHaveBeenCalledWith(409);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('releases the global folder claim it just took when the ingest enqueue fails', async () => {
    // The row holds the GLOBAL driveFolderId claim; a stranded one locks the folder out for every
    // org (a disabled row still populates the unique index), so a failed enqueue must hard-delete it.
    h.sendToQueue.mockRejectedValue(new Error('queue unavailable'));
    const { res, status } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /could not queue/i
    );

    expect(h.connRelease).toHaveBeenCalledWith('conn1', 'orgA');
    expect(status).not.toHaveBeenCalledWith(202);
  });

  it('does not delete a pre-existing connection when a re-sync enqueue fails', async () => {
    // The reuse branch did not take the claim - tearing down a working connection over a missed
    // re-sync would be worse than the missed ingest (the resync poll re-enqueues it).
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    h.sendToQueue.mockRejectedValue(new Error('queue unavailable'));
    const { res, status } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /could not queue/i
    );

    expect(h.connRelease).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith(202);
  });

  it('still fails the request when the claim release itself fails', async () => {
    h.sendToQueue.mockRejectedValue(new Error('queue unavailable'));
    h.connRelease.mockRejectedValue(new Error('mongo down'));
    const { res, status } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /could not queue/i
    );
    expect(status).not.toHaveBeenCalledWith(202);
  });

  it('does not leak the underlying enqueue error to the caller', async () => {
    // An SQS/IAM failure message carries queue urls and account ids - it is log-only.
    h.sendToQueue.mockRejectedValue(new Error('AccessDenied for arn:aws:sqs:us-east-2:secret'));
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /^Could not queue the Google Drive ingest\. Please try again\.$/
    );
  });

  it('rejects an invalid Drive folder id before any lookup', async () => {
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: 'bad id!' }), res)).rejects.toThrow(
      /valid drive folder id/i
    );
    expect(h.dlFindById).not.toHaveBeenCalled();
  });
});
