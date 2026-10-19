import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

/**
 * POST /api/organizations/[id]/upload-logo. The real `verifyOrgAccess` runs here (only the repository
 * under it is mocked), so the role bar itself is pinned: an upload deletes the current logo for the
 * whole org, so only the owner, the manager or a platform admin may start one, and everyone else gets
 * the same non-enumerating 404 before anything is read or deleted.
 */

const ORG_ID = '64b7f0c2a1b2c3d4e5f60718';
const OWNER = 'owner1';
const MANAGER = 'manager1';
const MEMBER = 'member1';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: (req: unknown, res: unknown) => unknown) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const repoFindById = vi.hoisted(() => vi.fn());
const orgFindById = vi.hoisted(() => vi.fn());
const orgUpdateOne = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: repoFindById },
  Organization: { findById: orgFindById, updateOne: orgUpdateOne },
}));

const appFileFindByIdAndDelete = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/content', () => {
  class AppFile {
    id = 'newfile1';
    save = vi.fn(async () => undefined);
    static findByIdAndDelete = appFileFindByIdAndDelete;
  }
  return { AppFile };
});

vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: (session: unknown) => unknown) => fn({}),
}));

const storageDelete = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    delete = storageDelete;
    getSignedUrl = vi.fn(async () => 'https://signed.example/put');
  },
}));

vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'bucket' } } }));
vi.mock('@server/utils/browserUploadUrl', () => ({
  resolveBrowserAppFileUploadUrl: (_id: string, url: string) => url,
}));

import '../upload-logo';

const ORG = {
  id: ORG_ID,
  userId: OWNER,
  managerId: MANAGER,
  users: [{ userId: OWNER }, { userId: MANAGER }, { userId: MEMBER }],
};
const sessionChain = () => ({ session: vi.fn(async () => undefined) });

const invoke = async (user: { id: string; isAdmin: boolean }, orgId = ORG_ID) => {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: orgId },
    body: { fileName: 'logo.png', mimeType: 'image/png', fileSize: 1024 },
  });
  (req as unknown as { user: unknown }).user = user;
  await mockRefs.postHandler!(req, res);
  return res;
};

describe('POST /api/organizations/[id]/upload-logo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoFindById.mockResolvedValue(ORG);
    orgFindById.mockReturnValue({
      populate: vi.fn(async () => ({ ...ORG, name: 'Acme', logo: { id: 'oldfile1', path: 'organizations/old.png' } })),
    });
    orgUpdateOne.mockImplementation(sessionChain);
    appFileFindByIdAndDelete.mockImplementation(sessionChain);
  });

  it.each([
    ['a plain member', { id: MEMBER, isAdmin: false }],
    ['a non-member', { id: 'stranger1', isAdmin: false }],
  ])('refuses %s with a 404 and deletes nothing', async (_label, user) => {
    await expect(invoke(user)).rejects.toBeInstanceOf(NotFoundError);
    expect(repoFindById).toHaveBeenLastCalledWith(ORG_ID);
    expect(orgFindById).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
    expect(appFileFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['the owner', { id: OWNER, isAdmin: false }],
    ['the manager', { id: MANAGER, isAdmin: false }],
    ['a platform admin', { id: 'admin1', isAdmin: true }],
  ])('lets %s replace the logo', async (_label, user) => {
    const res = await invoke(user);

    expect(repoFindById).toHaveBeenLastCalledWith(ORG_ID);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ url: 'https://signed.example/put', fileId: 'newfile1' });
    expect(storageDelete).toHaveBeenCalledWith('organizations/old.png');
  });

  it('answers 404 when the org does not exist', async () => {
    repoFindById.mockResolvedValue(null);

    await expect(invoke({ id: OWNER, isAdmin: false })).rejects.toBeInstanceOf(NotFoundError);
    expect(storageDelete).not.toHaveBeenCalled();
  });

  it('rejects a malformed org id before any lookup', async () => {
    await expect(invoke({ id: OWNER, isAdmin: false }, 'not-an-id')).rejects.toBeInstanceOf(BadRequestError);
    expect(repoFindById).not.toHaveBeenCalled();
    expect(orgFindById).not.toHaveBeenCalled();
  });
});
