import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/invites/[id]/accept returns the accepted invite to the invitee;
 * co-recipients' emails must be filtered out of the response.
 */

// `any` below is deliberate test-mock plumbing: typing the full next-connect /
// node-mocks-http chain adds no coverage value (matches the repo's handler-test convention).
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const acceptInvite = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    id: 'inv1',
    type: 'Session', // not Project/FabFile, so the extra branches are skipped
    documentId: 'doc1',
    recipients: { pending: [], accepted: ['me@x.com', 'other@x.com'], refused: [] },
  })
);
const tagMocks = vi.hoisted(() => ({
  fabFileFindById: vi.fn(),
  findAllByUserId: vi.fn(),
  findOrCreateByNameAndUserId: vi.fn(),
}));
vi.mock('@bike4mind/services', () => ({ sharingService: { acceptInvite } }));
vi.mock('@bike4mind/database', () => ({
  // accept.ts adapters + inviteManager's module-load imports
  inviteRepository: {},
  Organization: {},
  sessionRepository: {},
  projectRepository: {},
  fabFileRepository: { findById: tagMocks.fabFileFindById },
  userRepository: {},
  Project: { findById: vi.fn() },
  fileTagRepository: {
    findAllByUserId: tagMocks.findAllByUserId,
    findOrCreateByNameAndUserId: tagMocks.findOrCreateByNameAndUserId,
  },
  withTransaction: (fn: any) => fn(),
  FabFile: {},
  Group: {},
  Session: {},
  User: {},
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://x' } } }));

import '@pages/api/invites/[id]/accept';

describe('POST /api/invites/[id]/accept - recipient filtering', () => {
  beforeEach(() => acceptInvite.mockClear());

  it('strips co-recipients from the returned invite', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv1' } });
    (req as any).user = { id: 'u1', email: 'me@x.com' };
    (req as any).ability = {};
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.recipients.accepted).toEqual(['me@x.com']);
    expect(JSON.stringify(body)).not.toContain('other@x.com');
  });
});

/**
 * Accepting a FabFile invite copies the shared file's tag names onto the recipient. The upsert it
 * uses matches a name exactly, so the folding here is the only thing stopping a file that stores
 * both `Invoices` and `invoices` from minting the recipient two tags for one name.
 */
describe('POST /api/invites/[id]/accept - file tag transfer', () => {
  const acceptFileInvite = () => {
    acceptInvite.mockResolvedValueOnce({
      id: 'inv1',
      type: 'FabFile',
      documentId: 'file1',
      recipients: { pending: [], accepted: ['me@x.com'], refused: [] },
    });
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv1' } });
    (req as any).user = { id: 'u1', email: 'me@x.com' };
    (req as any).ability = {};
    return mockRefs.postHandler!(req, res);
  };

  beforeEach(() => {
    acceptInvite.mockClear();
    tagMocks.fabFileFindById.mockReset();
    tagMocks.findAllByUserId.mockReset().mockResolvedValue([]);
    tagMocks.findOrCreateByNameAndUserId.mockReset().mockResolvedValue(null);
  });

  it('copies one tag per folded name when the file stores two casings of it', async () => {
    tagMocks.fabFileFindById.mockResolvedValue({
      id: 'file1',
      userId: 'owner',
      tags: [
        { name: 'Invoices', strength: 0 },
        { name: 'invoices', strength: 0 },
      ],
    });

    await acceptFileInvite();

    expect(tagMocks.findOrCreateByNameAndUserId).toHaveBeenCalledTimes(1);
    // The first spelling seen wins, since either one folds to the same held tag.
    expect(tagMocks.findOrCreateByNameAndUserId).toHaveBeenCalledWith('Invoices', 'u1', expect.any(Object));
  });

  it('copies genuinely distinct tags separately', async () => {
    tagMocks.fabFileFindById.mockResolvedValue({
      id: 'file1',
      userId: 'owner',
      tags: [
        { name: 'invoices', strength: 0 },
        { name: 'invoices-2024', strength: 0 },
      ],
    });

    await acceptFileInvite();

    expect(tagMocks.findOrCreateByNameAndUserId).toHaveBeenCalledTimes(2);
  });

  it('carries the owner tag presentation across when the owner holds the tag', async () => {
    tagMocks.fabFileFindById.mockResolvedValue({
      id: 'file1',
      userId: 'owner',
      tags: [{ name: 'invoices', strength: 0 }],
    });
    tagMocks.findAllByUserId.mockResolvedValue([{ id: 't1', name: 'Invoices', icon: '*', color: '#123456' }]);

    await acceptFileInvite();

    expect(tagMocks.findOrCreateByNameAndUserId).toHaveBeenCalledWith(
      'invoices',
      'u1',
      expect.objectContaining({ icon: '*', color: '#123456' })
    );
  });

  it('transfers nothing for a file with no tags', async () => {
    tagMocks.fabFileFindById.mockResolvedValue({ id: 'file1', userId: 'owner', tags: [] });

    await acceptFileInvite();

    expect(tagMocks.findOrCreateByNameAndUserId).not.toHaveBeenCalled();
  });
});
