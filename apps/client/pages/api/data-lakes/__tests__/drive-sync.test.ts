import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATA_LAKE_STATUSES } from '@bike4mind/common';
import type { DriveConnectionOwner } from '@bike4mind/common';

const orgAOwner: DriveConnectionOwner = { kind: 'organization', organizationId: 'orgA' };

// Unit-level test of the connect handler's gate + org-credential capture. The repository layer,
// AWS/SQS, auth gate, and crypto are mocked; the Drive folder-id validation runs for real.
const h = vi.hoisted(() => ({
  claimTryAcquire: vi.fn(async () => ({ acquired: true })),
  claimRelease: vi.fn(async () => true),
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
  ghConnFindByDataLakeIdAny: vi.fn(),
  gatedFlags: [] as string[],
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
// Records which flags the route gates on, so a test can pin that the GitHub flag is not one of them.
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => (h.gatedFlags.push(flag), () => {}),
}));
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
    lakeConnectorClaimRepository: {
      ...actual.lakeConnectorClaimRepository,
      tryAcquire: h.claimTryAcquire,
      releaseByConnectionId: h.claimRelease,
    },
    orgGitHubLakeConnectionRepository: {
      ...actual.orgGitHubLakeConnectionRepository,
      findByDataLakeIdAny: h.ghConnFindByDataLakeIdAny,
    },
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
    // origin: 'connector-fed' so these unrelated tests clear the origin gate; its own polarity is
    // pinned separately below (curated / no-origin-stored / connector-fed cases).
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', status: 'active', origin: 'connector-fed' });
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
    h.getFolderAccess.mockResolvedValue({ ok: true, exists: true, isFolder: true, canRead: true });
    h.ghConnFindByDataLakeIdAny.mockResolvedValue(null);
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
    h.getFolderAccess.mockResolvedValue({ ok: true, exists: false, isFolder: false, canRead: false });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /do not have access/i
    );
    expect(h.connFindByDriveFolderId).not.toHaveBeenCalled();
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('tells the user Drive is throttling us rather than that they lost access to their folder', async () => {
    // The conflation this guards: a throttled probe used to come back `exists: false`, so the user
    // was told they had no access to a folder they own and went hunting a permission problem that
    // did not exist. The claim is still refused - it just says the true reason.
    h.getFolderAccess.mockResolvedValue({ ok: false, reason: 'rate_limited', detail: '429' });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
      /rate-limiting/i
    );
    expect(h.connFindByDriveFolderId).not.toHaveBeenCalled();
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a readable id that is a file, not a folder', async () => {
    h.getFolderAccess.mockResolvedValue({ ok: true, exists: true, isFolder: false, canRead: true });
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

  it('connects a personal (org-less) lake for its creator, storing no org credential', async () => {
    h.dlFindById.mockResolvedValue({
      id: 'lake1',
      organizationId: undefined,
      status: 'active',
      origin: 'connector-fed',
      createdByUserId: 'u1',
    });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    expect(h.connCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        driveFolderId: FOLDER_ID,
        targetDataLakeId: 'lake1',
        connectedBy: 'u1',
      })
    );
    // A personal connection carries no org-owned credential copy: it syncs on the owner's live grant.
    const created = h.connCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(created).not.toHaveProperty('organizationId');
    expect(created).not.toHaveProperty('oauthRefreshToken');
    expect(status).toHaveBeenCalledWith(202);
  });

  it('404s a non-creator on a personal (org-less) lake, before any Drive call', async () => {
    h.dlFindById.mockResolvedValue({
      id: 'lake1',
      organizationId: undefined,
      status: 'active',
      origin: 'connector-fed',
      createdByUserId: 'owner2',
    });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/not found/i);

    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    expect(h.getFolderAccess).not.toHaveBeenCalled();
    expect(h.connCreate).not.toHaveBeenCalled();
  });

  it('refreshes a personal connection on reuse, writing no credential', async () => {
    h.dlFindById.mockResolvedValue({
      id: 'lake1',
      organizationId: undefined,
      status: 'active',
      origin: 'connector-fed',
      createdByUserId: 'u1',
    });
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(h.connUpdateCredential).toHaveBeenCalledWith('conn1', { kind: 'user', userId: 'u1' }, null, 'u1');
    expect(status).toHaveBeenCalledWith(202);
  });

  it.each(DATA_LAKE_STATUSES.filter(s => s !== 'draft' && s !== 'active'))(
    'refuses to connect a folder to a lake in %s status',
    async status => {
      // Otherwise the connect door hands a non-writable lake an `enabled: true` connection and the
      // poll enqueues it forever - work the ingest guard then drops every time - while the UI toasts
      // a sync that will never happen. Same draft/active rule as the batch-create and presign doors.
      h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', status });
      const { res } = makeRes();
      await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(
        new RegExp(`'${status}' status`)
      );
      // Gated before the credential capture and the Drive read probe, so a refused connect costs
      // neither; and nothing is written.
      expect(h.userFindById).not.toHaveBeenCalled();
      expect(h.getFolderAccess).not.toHaveBeenCalled();
      expect(h.connCreate).not.toHaveBeenCalled();
      expect(h.connUpdateCredential).not.toHaveBeenCalled();
      expect(h.sendToQueue).not.toHaveBeenCalled();
    }
  );

  it('connects a draft lake (the first sync of a freshly created lake)', async () => {
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', status: 'draft', origin: 'connector-fed' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);
    expect(h.connCreate).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(202);
  });

  it('404s an unknown lake', async () => {
    h.dlFindById.mockResolvedValue(null);
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'nope', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/not found/i);
  });

  it('409s a NEW claim on a lake a GitHub repository already feeds (guard runs on the create branch, after the folder probe)', async () => {
    h.ghConnFindByDataLakeIdAny.mockResolvedValue({ id: 'gh1', targetDataLakeId: 'lake1' });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/already connected to a GitHub repository/i),
    });
    expect(h.ghConnFindByDataLakeIdAny).toHaveBeenCalledWith('lake1');
    // Credential capture and the Drive folder probe now legitimately happen before the guard - only
    // the write itself must be refused.
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    // The legacy-row check runs under the claim, so the refusal must hand the claim back.
    const [{ connectionId }] = h.claimTryAcquire.mock.calls[0] as unknown as [{ connectionId: string }];
    expect(h.claimRelease).toHaveBeenCalledWith(connectionId);
  });

  it('takes the lake claim on a NEW connect and writes the row under the claimed id', async () => {
    const { res } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(h.claimTryAcquire).toHaveBeenCalledWith(expect.objectContaining({ lakeId: 'lake1', kind: 'googleDrive' }));
    const [{ connectionId }] = h.claimTryAcquire.mock.calls[0] as unknown as [{ connectionId: string }];
    const [created] = h.connCreate.mock.calls[0] as [{ _id: { toString(): string } }];
    expect(created._id.toString()).toBe(connectionId);
    expect(h.claimRelease).not.toHaveBeenCalled();
  });

  it('409s a NEW claim when another connector already holds the lake claim', async () => {
    h.claimTryAcquire.mockResolvedValueOnce({
      acquired: false,
      holder: { kind: 'github', connectionId: 'gh1', claimedAt: new Date() },
    });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/already connected to a GitHub repository/i),
    });
    expect(h.connCreate).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('re-syncs a same-lake same-folder Drive connection even though a GitHub row also feeds the lake (reuse branch never calls the guard)', async () => {
    // Regression test: the guard used to run before the folder lookup and would 409 every request on
    // a lake that also carries a GitHub row, including a harmless same-folder Re-sync. It now lives
    // only on the NEW-claim branch, so a reuse must reach 202 regardless of what else feeds the lake.
    h.ghConnFindByDataLakeIdAny.mockResolvedValue({ id: 'gh1', targetDataLakeId: 'lake1' });
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(h.connUpdateCredential).toHaveBeenCalledWith('conn1', orgAOwner, 'enc-refresh', 'u1');
    expect(h.sendToQueue).toHaveBeenCalledWith('queue-url', { connectionId: 'conn1', forceFullWalk: true });
    expect(status).toHaveBeenCalledWith(202);
    expect(h.ghConnFindByDataLakeIdAny).not.toHaveBeenCalled();
    expect(h.claimTryAcquire).not.toHaveBeenCalled();
  });

  it('enforces one connector per lake whatever EnableDataLakeGitHub is set to', () => {
    // The route gates on EnableDataLakes alone, so the GitHub flag (off or on) cannot switch the check
    // above off - with it off the client cannot see the bound repository, so this route is the guard.
    expect(h.gatedFlags).toEqual(['EnableDataLakes']);
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
    const [{ connectionId }] = h.claimTryAcquire.mock.calls[0] as unknown as [{ connectionId: string }];
    expect(h.claimRelease).toHaveBeenCalledWith(connectionId);
  });

  it('reuses the same folder+lake connection, refreshes its credential, and re-stamps connectedBy', async () => {
    h.connFindByDriveFolderId.mockResolvedValue({ id: 'conn1', targetDataLakeId: 'lake1' });
    const { res, status } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    // connectedBy is re-stamped to the re-syncing caller so ingest never runs as a deleted user.
    expect(h.connUpdateCredential).toHaveBeenCalledWith('conn1', orgAOwner, 'enc-refresh', 'u1');
    expect(h.connCreate).not.toHaveBeenCalled();
    // This IS the "Re-sync everything" surface (#2396): reconnecting an existing connection forces a
    // full walk rather than trusting its (possibly stale, possibly absent) syncCursor.
    expect(h.sendToQueue).toHaveBeenCalledWith('queue-url', { connectionId: 'conn1', forceFullWalk: true });
    expect(status).toHaveBeenCalledWith(202);
  });

  it('409s a reconnect while the folder disconnect purge is still queued, without re-enabling it', async () => {
    h.connFindByDriveFolderId.mockResolvedValue({
      id: 'conn1',
      targetDataLakeId: 'lake1',
      disconnectRequestedAt: new Date(),
    });
    const { res, status, json } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ error: expect.stringMatching(/still being disconnected/) });
    expect(h.connUpdateCredential).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
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

    expect(h.connRelease).toHaveBeenCalledWith('conn1', orgAOwner);
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

  it('refuses to connect a folder to a curated lake, before any Drive call', async () => {
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', status: 'active', origin: 'curated' });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/curated/i);

    // Refused before the credential capture, so a rejected connect costs no Drive calls.
    expect(h.getValidUserDriveAccessToken).not.toHaveBeenCalled();
    expect(h.getFolderAccess).not.toHaveBeenCalled();
    expect(h.connCreate).not.toHaveBeenCalled();
  });

  it('refuses to connect a folder to a lake with no origin stored, before any Drive call', async () => {
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', status: 'active' });
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res)).rejects.toThrow(/curated/i);

    // Fails closed, same as the curated case above: only an explicit 'connector-fed' passes.
    expect(h.getValidUserDriveAccessToken).not.toHaveBeenCalled();
    expect(h.getFolderAccess).not.toHaveBeenCalled();
    expect(h.connCreate).not.toHaveBeenCalled();
  });

  it('connects a folder to a connector-fed lake', async () => {
    h.dlFindById.mockResolvedValue({
      id: 'lake1',
      organizationId: 'orgA',
      status: 'active',
      origin: 'connector-fed',
    });
    // clearAllMocks() only clears call history, not implementations - a prior test's
    // sendToQueue rejection would otherwise leak in since this runs after those cases.
    h.sendToQueue.mockResolvedValue(undefined);
    const { res } = makeRes();
    await run(makeReq({ dataLakeId: 'lake1', driveFolderId: FOLDER_ID }), res);

    expect(h.getFolderAccess).toHaveBeenCalled();
  });
});
