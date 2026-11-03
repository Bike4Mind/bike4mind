// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockAuditFailure } = vi.hoisted(() => ({ mockAuditFailure: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({ userRepository: { findById: vi.fn(), update: vi.fn() } }));
vi.mock('@server/integrations/notion', () => ({
  getNotionOAuthConfig: vi.fn(async () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'r' })),
  NOTION_OAUTH_TOKEN_URL: 'https://api.notion.com/v1/oauth/token',
  NOTION_API_BASE_URL: 'https://api.notion.com/v1',
  NOTION_VERSION: '2022-06-28',
}));
vi.mock('@server/integrations/notion/notionTokenManager', () => ({ NotionTokenManager: class {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({
      setUserId: vi.fn(),
      success: vi.fn(),
      failure: (...a: unknown[]) => mockAuditFailure(...a),
    }),
  },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ encryptToken: (t: string) => t }));

import handler from '../callback';

const call = async (query: Record<string, string>) => {
  const { req, res } = createMocks({ method: 'GET', query });
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/mcp-servers/notion/callback - malformed state', () => {
  it('rejects a non-JSON state at warn level so caller junk does not raise an alert', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call({ code: 'auth-code', state: 'y' });

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('invalid_state');
    expect(warnSpy).toHaveBeenCalledWith('[Notion Callback] Failed to parse state parameter:', expect.any(SyntaxError));
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('rejects a state that is absent entirely at warn level', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call({ code: 'auth-code' });

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('missing_state');
    expect(warnSpy).toHaveBeenCalledWith('[Notion Callback] Missing state parameter');
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
