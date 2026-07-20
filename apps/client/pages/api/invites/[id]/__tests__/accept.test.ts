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
vi.mock('@bike4mind/services', () => ({ sharingService: { acceptInvite } }));
vi.mock('@bike4mind/database', () => ({
  // accept.ts adapters + inviteManager's module-load imports
  inviteRepository: {},
  Organization: {},
  sessionRepository: {},
  projectRepository: {},
  fabFileRepository: {},
  userRepository: {},
  Project: { findById: vi.fn() },
  fileTagRepository: {},
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
