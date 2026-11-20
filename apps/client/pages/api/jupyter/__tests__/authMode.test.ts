import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Both notebook routes are browser-only (NotebookExecutionButtons) and execute
 * relays the notebook to the user's CLI, which runs it locally. `jwtOnly` keeps
 * baseApi from installing the api-key chain, so no API key can reach either.
 */

const mockRefs = vi.hoisted(() => ({ baseApiOptions: [] as unknown[] }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, () => unknown> = {};
  chain.use = chain.get = chain.post = () => chain;
  return {
    baseApi: (opts: unknown) => {
      mockRefs.baseApiOptions.push(opts);
      return chain;
    },
  };
});
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToConnection: vi.fn() }));
vi.mock('@bike4mind/database/social', () => ({ Connection: {} }));
vi.mock('@bike4mind/database/content', () => ({ Quest: {} }));

describe('jupyter routes - auth mode', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRefs.baseApiOptions = [];
  });

  it.each(['execute', 'progress'])('/api/jupyter/%s accepts only a session JWT', async route => {
    await import(`../${route}.ts`);

    expect(mockRefs.baseApiOptions).toEqual([{ auth: 'jwtOnly' }]);
  });
});
