import { describe, it, expect, vi } from 'vitest';

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
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, get: () => chain, post: () => chain };
  return {
    baseApi: (opts: unknown) => {
      mockRefs.baseApiOptions = opts;
      return chain;
    },
  };
});

vi.mock('@bike4mind/database', () => ({
  wsConnectTicketRepository: { create: vi.fn() },
}));

// Import after mocks are registered so the baseApi options capture runs.
import '@pages/api/websocket/ticket';

describe('POST /api/websocket/ticket - auth mode', () => {
  it('is minted jwtOnly so an API key cannot mint a connect ticket', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
    // auth: true would install apiKeyAuth(undefined), letting any valid API key mint.
    expect((mockRefs.baseApiOptions as { auth?: unknown }).auth).not.toBe(true);
  });
});
