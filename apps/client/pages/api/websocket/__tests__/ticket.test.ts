import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The connect-ticket mint endpoint must be JWT-only. `jwtOnly` is what tells
 * baseApi to skip installing the api-key credential chain, so a valid
 * `b4m_live_` API key (even one lacking AI_GENERATE/AI_CHAT/CC_BRIDGE) cannot
 * mint a web connect ticket and open a scope-less `source: 'web'` socket that
 * routes around the connect-time scope gate resolveIdentity enforces on the
 * API-key path. Pinning the auth mode is the regression guard for that.
 */

const mockRefs = vi.hoisted(() => ({
  baseApiOptions: undefined as unknown,
  postHandler: undefined as unknown as (req: unknown, res: unknown) => Promise<void>,
  createTicket: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (handler: typeof mockRefs.postHandler) => {
      mockRefs.postHandler = handler;
      return chain;
    },
  };
  return {
    baseApi: (opts: unknown) => {
      mockRefs.baseApiOptions = opts;
      return chain;
    },
  };
});

vi.mock('@bike4mind/database', () => ({
  wsConnectTicketRepository: { create: mockRefs.createTicket },
}));

// Import after mocks are registered so the baseApi options capture runs.
import '@pages/api/websocket/ticket';

describe('POST /api/websocket/ticket - auth mode', () => {
  it('is minted jwtOnly so an API key cannot mint a connect ticket', () => {
    // Also out of the default write limit: reconnect retries must not spend the user's write budget.
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly', defaultWriteRateLimit: false });
    // auth: true would install apiKeyAuth(undefined), letting any valid API key mint.
    expect((mockRefs.baseApiOptions as { auth?: unknown }).auth).not.toBe(true);
  });
});

describe('POST /api/websocket/ticket - minted ticket', () => {
  const mint = async (user: Record<string, unknown>) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req = { user, logger: { updateMetadata: vi.fn() } };
    await mockRefs.postHandler(req, res);
    return res;
  };

  beforeEach(() => {
    mockRefs.createTicket.mockReset();
    mockRefs.createTicket.mockResolvedValue(undefined);
  });

  it("carries the minting session's sid and the access token expiry onto the ticket", async () => {
    const accessTokenExpiresAt = new Date('2030-01-01T00:30:00Z');

    const res = await mint({ id: 'user-1', tokenVersion: 4, sid: 'sid-1', accessTokenExpiresAt });

    expect(mockRefs.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', tokenVersion: 4, sid: 'sid-1', authExpiresAt: accessTokenExpiresAt })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('omits sid for a sid-less token and still stamps an expiry', async () => {
    await mint({ id: 'user-1' });

    const ticket = mockRefs.createTicket.mock.calls[0][0];
    expect(ticket).not.toHaveProperty('sid');
    expect(ticket.authExpiresAt).toBeInstanceOf(Date);
  });
});
