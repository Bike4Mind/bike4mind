// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
const mockFindById = vi.hoisted(() => vi.fn());

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) =>
        h[(req as { method?: string }).method ?? 'POST']?.(
          Object.assign(req as object, { logger: mockLogger, user: { id: 'user-1' } }),
          res
        ),
      { post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain) }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockFindById(...a), update: vi.fn() },
  mcpServerRepository: {},
}));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianConfig', () => ({
  getAtlassianOAuthConfig: vi.fn(async () => ({ clientId: 'c', clientSecret: 'client-secret-xyz' })),
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (t: string) => t,
  decryptToken: (t: string) => t,
  encryptEnvVariables: (v: unknown) => v,
}));

import handler from '../refresh';

describe('POST /api/mcp-servers/atlassian/refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the provider response body out of the logs and the thrown error', async () => {
    mockFindById.mockResolvedValue({ atlassianConnect: { refreshToken: 'refresh-token-xyz' } });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('provider-body-secret', { status: 400 }));
    const { req, res } = createMocks({ method: 'POST' });

    const error = await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res).catch(
      (e: unknown) => e
    );
    fetchSpy.mockRestore();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('provider-body-secret');
    const logged = JSON.stringify([mockLogger.error.mock.calls, mockLogger.warn.mock.calls], (_key, value) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value
    );
    expect(logged).toContain('Atlassian token refresh failed');
    expect(logged).toContain('status 400');
    for (const secret of ['provider-body-secret', 'refresh-token-xyz', 'client-secret-xyz']) {
      expect(logged).not.toContain(secret);
    }
  });
});
