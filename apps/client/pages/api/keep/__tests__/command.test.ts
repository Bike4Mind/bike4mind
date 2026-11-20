import { describe, it, expect, vi } from 'vitest';

/**
 * A Keep command runs on the user's own machine, so the REST relay must accept
 * only a signed-in session: `jwtOnly` keeps baseApi from installing the api-key
 * chain, and there is no unauthenticated dev fallback.
 */

const mockRefs = vi.hoisted(() => ({ baseApiOptions: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, () => unknown> = {};
  chain.use = chain.get = chain.post = () => chain;
  return {
    baseApi: (opts: unknown) => {
      mockRefs.baseApiOptions = opts;
      return chain;
    },
  };
});
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@bike4mind/database/social', () => ({ Connection: {} }));

import '@pages/api/keep/command';

describe('/api/keep/command - auth mode', () => {
  it('accepts only a session JWT, in every environment', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });
});
